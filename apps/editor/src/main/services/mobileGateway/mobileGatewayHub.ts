/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Aggregates the per-window renderer bridges into the phone-facing stream.
 *  One hub owns every WebSocket subscriber: inbox fan-out, per-session snapshots
 *  + monotonic deltas, backpressure resync, and command routing. Window ids and
 *  workspace names (main-only facts) are stamped here; renderers never see them.
 *--------------------------------------------------------------------------------------------*/

import type { ILogger } from '@universe-editor/platform'
import {
  MAX_SERVER_FRAME_BYTES,
  type CommandFrame,
  type MobileSessionEvent,
  type MobileSessionRef,
  type MobileSessionSnapshot,
  type MobileSessionSummary,
  type ServerFrame,
  type SessionSnapshotFrame,
} from '@universe-editor/mobile-protocol'
import type {
  IMobileBridgeService,
  MobileBridgeEvent,
  MobileBridgeSessionEvent,
  MobileBridgeSessionSummary,
} from '../../../shared/ipc/mobileGatewayService.js'

/** Once a socket has this much queued we drop deltas and ask the phone to resync. */
export const MAX_BUFFERED_SESSION_BYTES = 1024 * 1024

export interface MobileGatewayHubConnection {
  /** Synchronous send; the server drops frames when the socket is not open. */
  send(frame: ServerFrame): void
  /** Current `WebSocket.bufferedAmount`. */
  bufferedAmount(): number
}

interface WindowEntry {
  readonly windowId: number
  readonly bridge: IMobileBridgeService
  readonly workspaceName: () => string
  /** Subscribed lazily in `_startBridge`: the renderer channel may not exist yet. */
  subscription: { dispose(): void } | undefined
}

interface SessionSubscription {
  readonly windowId: number
  readonly localId: string
  ref: MobileSessionRef
  seq: number
  snapshotPending: boolean
  buffered: MobileSessionEvent[]
  desynced: boolean
  cancelled: boolean
}

interface HubConnectionState {
  readonly connection: MobileGatewayHubConnection
  inbox: boolean
  inboxSnapshotPending: boolean
  bufferedInbox: Array<{
    readonly upserts: readonly MobileSessionSummary[]
    readonly removes: readonly MobileSessionRef[]
  }>
  readonly sessions: Map<string, SessionSubscription>
}

interface InboxEntry {
  readonly windowId: number
  readonly summary: MobileSessionSummary
}

const sessionKey = (windowId: number, localId: string): string => `${windowId}:${localId}`

export class MobileGatewayHub {
  private readonly _windows = new Map<number, WindowEntry>()
  private readonly _connections = new Set<HubConnectionState>()
  private readonly _inboxState = new Map<string, InboxEntry>()
  private _inboxSeq = 0
  private _streaming = false

  constructor(private readonly _logger: ILogger) {}

  registerWindow(
    windowId: number,
    bridge: IMobileBridgeService,
    workspaceName: () => string = () => '',
  ): void {
    this.unregisterWindow(windowId)
    const entry: WindowEntry = { windowId, bridge, workspaceName, subscription: undefined }
    this._windows.set(windowId, entry)
    if (this._hasSubscribers()) {
      void this._startBridge(entry)
    }
  }

  unregisterWindow(windowId: number): void {
    const entry = this._windows.get(windowId)
    if (entry === undefined) return
    this._windows.delete(windowId)
    this._stopBridge(entry)

    const removes: MobileSessionRef[] = []
    for (const [key, value] of this._inboxState) {
      if (value.windowId !== windowId) continue
      this._inboxState.delete(key)
      removes.push(value.summary.ref)
    }
    for (const state of this._connections) {
      for (const [key, subscription] of state.sessions) {
        if (subscription.windowId !== windowId) continue
        state.sessions.delete(key)
        state.connection.send({ type: 'session_removed', ref: subscription.ref })
      }
    }
    if (removes.length > 0) this._broadcastInboxDelta([], removes)
    this._updateStreaming()
  }

  dispose(): void {
    for (const entry of this._windows.values()) {
      this._stopBridge(entry)
    }
    this._windows.clear()
    this._connections.clear()
    this._inboxState.clear()
    this._streaming = false
  }

  addConnection(connection: MobileGatewayHubConnection): void {
    this._connections.add({
      connection,
      inbox: false,
      inboxSnapshotPending: false,
      bufferedInbox: [],
      sessions: new Map(),
    })
  }

  removeConnection(connection: MobileGatewayHubConnection): void {
    for (const state of this._connections) {
      if (state.connection !== connection) continue
      state.inbox = false
      state.sessions.clear()
      this._connections.delete(state)
      this._updateStreaming()
      return
    }
  }

  subscribeInbox(connection: MobileGatewayHubConnection): void {
    const state = this._find(connection)
    if (state === undefined) return
    if (state.inbox) {
      void this._sendInboxSnapshot(state)
      return
    }
    state.inbox = true
    this._updateStreaming()
    void this._sendInboxSnapshot(state)
  }

  unsubscribeInbox(connection: MobileGatewayHubConnection): void {
    const state = this._find(connection)
    if (state === undefined) return
    state.inbox = false
    state.inboxSnapshotPending = false
    state.bufferedInbox = []
    this._updateStreaming()
  }

  async subscribeSession(
    connection: MobileGatewayHubConnection,
    ref: MobileSessionRef,
  ): Promise<void> {
    const state = this._find(connection)
    if (state === undefined) return
    const resolved = this._resolveSession(ref)
    if (resolved === undefined) {
      connection.send({ type: 'session_removed', ref })
      return
    }
    const key = sessionKey(resolved.windowId, resolved.localId)
    const previous = state.sessions.get(key)
    if (previous !== undefined) {
      previous.cancelled = true
      state.sessions.delete(key)
    }
    const subscription: SessionSubscription = {
      windowId: resolved.windowId,
      localId: resolved.localId,
      ref: {
        windowId: resolved.windowId,
        localId: resolved.localId,
        ...(ref.durableId !== undefined ? { durableId: ref.durableId } : {}),
      },
      seq: 0,
      snapshotPending: true,
      buffered: [],
      desynced: false,
      cancelled: false,
    }
    state.sessions.set(key, subscription)
    this._updateStreaming()

    const entry = this._windows.get(resolved.windowId)
    if (entry === undefined) {
      state.sessions.delete(key)
      connection.send({ type: 'session_removed', ref })
      return
    }
    let snapshot: Awaited<ReturnType<IMobileBridgeService['getSnapshot']>>
    try {
      snapshot = await entry.bridge.getSnapshot(resolved.localId)
    } catch (err) {
      this._logger.warn(`mobile snapshot failed: ${String(err)}`)
      snapshot = undefined
    }
    if (subscription.cancelled) return
    if (snapshot === undefined) {
      state.sessions.delete(key)
      connection.send({ type: 'session_removed', ref })
      return
    }

    const summary = this._toProtocolSummary(entry, snapshot.summary)
    subscription.ref = summary.ref
    subscription.seq += 1
    const frame: SessionSnapshotFrame = {
      type: 'session_snapshot',
      seq: subscription.seq,
      session: this._fitSnapshot({
        ...snapshot,
        seq: subscription.seq,
        summary,
      }),
    }
    connection.send(frame)
    subscription.snapshotPending = false
    const buffered = subscription.buffered
    subscription.buffered = []
    this._sendSessionEvents(state, subscription, buffered)
  }

  unsubscribeSession(connection: MobileGatewayHubConnection, ref: MobileSessionRef): void {
    const state = this._find(connection)
    if (state === undefined) return
    const key =
      ref.durableId !== undefined
        ? this._findSubscriptionKeyByDurable(state, ref.durableId)
        : undefined
    if (key !== undefined) {
      state.sessions.delete(key)
      return
    }
    state.sessions.delete(sessionKey(ref.windowId, ref.localId))
  }

  async handleCommand(connection: MobileGatewayHubConnection, frame: CommandFrame): Promise<void> {
    if (frame.kind !== 'getToolCallDetail') {
      connection.send({
        type: 'command_result',
        requestId: frame.requestId,
        ok: false,
        error: 'not_supported',
      })
      return
    }
    const payload = frame.payload as { ref: MobileSessionRef; toolCallId: string }
    const resolved = this._resolveSession(payload.ref)
    if (resolved === undefined) {
      connection.send({
        type: 'command_result',
        requestId: frame.requestId,
        ok: false,
        error: 'session_not_found',
      })
      return
    }
    const entry = this._windows.get(resolved.windowId)
    if (entry === undefined) {
      connection.send({
        type: 'command_result',
        requestId: frame.requestId,
        ok: false,
        error: 'session_not_found',
      })
      return
    }
    try {
      const detail = await entry.bridge.getToolCallDetail(resolved.localId, payload.toolCallId)
      if (detail === undefined) {
        connection.send({
          type: 'command_result',
          requestId: frame.requestId,
          ok: false,
          error: 'session_not_found',
        })
        return
      }
      connection.send({
        type: 'command_result',
        requestId: frame.requestId,
        ok: true,
        result: detail,
      })
    } catch (err) {
      this._logger.warn(`mobile command failed: ${String(err)}`)
      connection.send({
        type: 'command_result',
        requestId: frame.requestId,
        ok: false,
        error: 'internal',
      })
    }
  }

  private _find(connection: MobileGatewayHubConnection): HubConnectionState | undefined {
    for (const state of this._connections) {
      if (state.connection === connection) return state
    }
    return undefined
  }

  private _handleBridgeEvent(windowId: number, event: MobileBridgeEvent): void {
    const entry = this._windows.get(windowId)
    if (entry === undefined) return
    if (event.kind === 'inbox') {
      const upserts = event.upserts.map((summary) => this._toProtocolSummary(entry, summary))
      for (const summary of upserts) {
        this._inboxState.set(sessionKey(windowId, summary.ref.localId), {
          windowId,
          summary,
        })
      }
      const removes: MobileSessionRef[] = []
      for (const ref of event.removes) {
        this._inboxState.delete(sessionKey(windowId, ref.localId))
        removes.push({
          windowId,
          localId: ref.localId,
          ...(ref.durableId !== undefined ? { durableId: ref.durableId } : {}),
        })
      }
      this._broadcastInboxDelta(upserts, removes)
      return
    }
    for (const state of this._connections) {
      const subscription = state.sessions.get(sessionKey(windowId, event.localId))
      if (subscription === undefined) continue
      const events = event.events.map((delta) => this._toProtocolEvent(entry, delta))
      for (const delta of events) {
        if (delta.type !== 'summary_changed') continue
        subscription.ref = delta.summary.ref
      }
      if (subscription.snapshotPending) {
        subscription.buffered.push(...events)
        continue
      }
      this._sendSessionEvents(state, subscription, events)
    }
  }

  private _sendSessionEvents(
    state: HubConnectionState,
    subscription: SessionSubscription,
    events: readonly MobileSessionEvent[],
  ): void {
    if (events.length === 0 || subscription.desynced) return
    if (state.connection.bufferedAmount() > MAX_BUFFERED_SESSION_BYTES) {
      subscription.desynced = true
      state.connection.send({
        type: 'resync_required',
        scope: 'session',
        reason: 'backpressure',
        ref: subscription.ref,
      })
      return
    }
    subscription.seq += 1
    state.connection.send({
      type: 'session_delta',
      seq: subscription.seq,
      ref: subscription.ref,
      events,
    })
  }

  private _broadcastInboxDelta(
    upserts: readonly MobileSessionSummary[],
    removes: readonly MobileSessionRef[],
  ): void {
    if (upserts.length === 0 && removes.length === 0) return
    for (const state of this._connections) {
      if (!state.inbox) continue
      if (state.inboxSnapshotPending) {
        state.bufferedInbox.push({ upserts, removes })
        continue
      }
      state.connection.send({
        type: 'inbox_delta',
        seq: ++this._inboxSeq,
        upserts,
        removes,
      })
    }
  }

  private async _sendInboxSnapshot(state: HubConnectionState): Promise<void> {
    state.inboxSnapshotPending = true
    state.bufferedInbox = []
    const sessions: MobileSessionSummary[] = []
    try {
      const windows = [...this._windows.values()]
      const lists = await Promise.all(
        windows.map(async (entry) => {
          const summaries = await entry.bridge.listSessions()
          return summaries.map((summary) => this._toProtocolSummary(entry, summary))
        }),
      )
      for (const list of lists) sessions.push(...list)
    } catch (err) {
      this._logger.warn(`mobile inbox snapshot failed: ${String(err)}`)
      state.inboxSnapshotPending = false
      return
    }
    if (!state.inbox) {
      state.inboxSnapshotPending = false
      return
    }
    for (const summary of sessions) {
      this._inboxState.set(sessionKey(summary.ref.windowId, summary.ref.localId), {
        windowId: summary.ref.windowId,
        summary,
      })
    }
    state.connection.send({ type: 'inbox_snapshot', seq: ++this._inboxSeq, sessions })
    state.inboxSnapshotPending = false
    const buffered = state.bufferedInbox
    state.bufferedInbox = []
    for (const delta of buffered) {
      state.connection.send({
        type: 'inbox_delta',
        seq: ++this._inboxSeq,
        upserts: delta.upserts,
        removes: delta.removes,
      })
    }
  }

  private _resolveSession(
    ref: MobileSessionRef,
  ): { windowId: number; localId: string } | undefined {
    if (ref.durableId !== undefined) {
      for (const value of this._inboxState.values()) {
        if (value.summary.ref.durableId !== ref.durableId) continue
        return { windowId: value.windowId, localId: value.summary.ref.localId }
      }
    }
    if (!this._windows.has(ref.windowId)) return undefined
    return { windowId: ref.windowId, localId: ref.localId }
  }

  private _findSubscriptionKeyByDurable(
    state: HubConnectionState,
    durableId: string,
  ): string | undefined {
    for (const [key, subscription] of state.sessions) {
      if (subscription.ref.durableId === durableId) return key
    }
    return undefined
  }

  private _toProtocolSummary(
    entry: WindowEntry,
    summary: MobileBridgeSessionSummary,
  ): MobileSessionSummary {
    return {
      ref: {
        windowId: entry.windowId,
        localId: summary.localId,
        ...(summary.durableId !== undefined ? { durableId: summary.durableId } : {}),
      },
      agentId: summary.agentId,
      ...(summary.agentName !== undefined ? { agentName: summary.agentName } : {}),
      title: summary.title,
      status: summary.status,
      displayStatus: summary.displayStatus,
      bucket: summary.bucket,
      workspaceName: this._workspaceName(entry),
      ...(summary.cwd !== undefined ? { cwd: summary.cwd } : {}),
      ...(summary.authority !== undefined ? { authority: summary.authority } : {}),
      readOnly: summary.readOnly,
      hasPendingPermission: summary.hasPendingPermission,
      hasPendingElicitation: summary.hasPendingElicitation,
      backgroundTaskCount: summary.backgroundTaskCount,
      updatedAt: summary.updatedAt,
    }
  }

  private _toProtocolEvent(
    entry: WindowEntry,
    event: MobileBridgeSessionEvent,
  ): MobileSessionEvent {
    if (event.type === 'summary_changed') {
      return { type: 'summary_changed', summary: this._toProtocolSummary(entry, event.summary) }
    }
    return event
  }

  private _workspaceName(entry: WindowEntry): string {
    try {
      return entry.workspaceName()
    } catch {
      return ''
    }
  }

  private _fitSnapshot(session: MobileSessionSnapshot): MobileSessionSnapshot {
    let frame: SessionSnapshotFrame = { type: 'session_snapshot', seq: session.seq, session }
    if (serializedLength(frame) <= MAX_SERVER_FRAME_BYTES) return session
    const timeline = [...session.timeline]
    while (timeline.length > 0) {
      timeline.shift()
      const candidate: MobileSessionSnapshot = { ...session, timeline, truncated: true }
      frame = { type: 'session_snapshot', seq: candidate.seq, session: candidate }
      if (serializedLength(frame) <= MAX_SERVER_FRAME_BYTES) return candidate
    }
    const truncated: MobileSessionSnapshot = { ...session, timeline: [], truncated: true }
    if (serializedLength(truncated) > MAX_SERVER_FRAME_BYTES) {
      this._logger.warn('mobile session snapshot exceeds the server frame soft limit')
    }
    return truncated
  }

  private _hasSubscribers(): boolean {
    for (const state of this._connections) {
      if (state.inbox || state.sessions.size > 0) return true
    }
    return false
  }

  private _updateStreaming(): void {
    const shouldStream = this._hasSubscribers()
    if (shouldStream === this._streaming) return
    this._streaming = shouldStream
    if (!shouldStream) this._inboxState.clear()
    for (const entry of this._windows.values()) {
      if (shouldStream) void this._startBridge(entry)
      else this._stopBridge(entry)
    }
  }

  private async _startBridge(entry: WindowEntry): Promise<void> {
    // Subscribe only now, not at registerWindow: main registers the window
    // before the renderer has registered its IPC channel, and an early
    // `listen` would be dropped without retry.
    entry.subscription ??= entry.bridge.onDidChange((event) =>
      this._handleBridgeEvent(entry.windowId, event),
    )
    try {
      await entry.bridge.startStreaming()
    } catch (err) {
      this._logger.warn(`mobile bridge start failed: ${String(err)}`)
    }
  }

  private _stopBridge(entry: WindowEntry): void {
    entry.subscription?.dispose()
    entry.subscription = undefined
    void entry.bridge.stopStreaming().catch((err) => {
      this._logger.debug(`mobile bridge stop failed: ${String(err)}`)
    })
  }
}

function serializedLength(frame: unknown): number {
  return JSON.stringify(frame).length
}
