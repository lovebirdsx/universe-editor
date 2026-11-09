/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Aggregates the per-window renderer bridges into the phone-facing stream.
 *  One hub owns every WebSocket subscriber: inbox fan-out, per-session snapshots
 *  + monotonic deltas, backpressure resync, and command routing. Window ids and
 *  workspace names (main-only facts) are stamped here; renderers never see them.
 *--------------------------------------------------------------------------------------------*/

import {
  arePathsEqual,
  CancellationTokenSource,
  normalizePlatform,
  REMOTE_SCHEME,
  URI,
  type CancellationToken,
  type ILogger,
} from '@universe-editor/platform'
import {
  MAX_SERVER_FRAME_BYTES,
  MAX_ID_LENGTH,
  MAX_STATUS_LENGTH,
  MAX_TITLE_LENGTH,
  MAX_WORKSPACE_NAME_LENGTH,
  clampText,
  isConfigValueAllowedOnMobile,
  parseServerFrame,
  serializeFrame,
  type CommandFrame,
  type MobileAgentCandidate,
  type MobileAttentionKind,
  type MobileErrorCode,
  type MobileNewSessionResult,
  type MobileSessionEvent,
  type MobileSessionRef,
  type MobileSessionSnapshot,
  type MobileSessionSummary,
  type MobileSideTaskSummary,
  type MobileWorkspaceCandidate,
  type ServerFrame,
  type SessionSnapshotFrame,
} from '@universe-editor/mobile-protocol'
import type {
  IMobileBridgeService,
  MobileBridgeAttentionEvent,
  MobileBridgeEvent,
  MobileBridgeNewSessionResult,
  MobileBridgePromptAttachment,
  MobileBridgeResult,
  MobileBridgeSessionEvent,
  MobileBridgeSessionSummary,
} from '../../../shared/ipc/mobileGatewayService.js'
import {
  MobileAttachmentError,
  type MobileGatewayAttachmentResolver,
} from './mobileAttachmentStore.js'

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
  /** Subscribed lazily: the renderer channel may not exist yet. */
  subscription: { dispose(): void } | undefined
  streaming: boolean
  attention: boolean
  /**
   * True once a ping reached this window's renderer. Main registers the
   * reverse channel before `loadURL`, so subscribe / startStreaming frames
   * sent earlier are dropped by the transport and nothing retries them.
   */
  rendererReady: boolean
  /** In-flight readiness probe, shared by the wiring and command paths. */
  readyProbe: Promise<boolean> | undefined
}

/** Main-owned attention fact, resolved from a bridge event and the inbox cache. */
export interface MobileGatewayAttention {
  readonly kind: MobileAttentionKind
  readonly ref: MobileSessionRef
  readonly title: string
  readonly agentName?: string
  readonly permissionTitle?: string
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

/** One workspace main can open or already has open. */
export interface MobileGatewayHostWorkspace {
  readonly windowId?: number
  /** URI string (`file:///…` / `remote-ssh://…`). */
  readonly folder: string
  readonly name: string
  readonly authority?: string
}

/** Main-owned facts the hub needs for `listWorkspaces` / `newSession`. */
export interface MobileGatewayHost {
  listOpenWorkspaces(): readonly MobileGatewayHostWorkspace[]
  listRecentWorkspaces(): Promise<readonly MobileGatewayHostWorkspace[]>
  openWorkspace(folder: string, authority?: string): Promise<void>
  /**
   * Resolve when the window is open and main has registered its reverse
   * channel, or undefined on timeout. The renderer may still be booting: its
   * IPC channel is registered long after this point, so callers must ping it
   * before issuing commands.
   */
  waitForBridge(
    folder: string,
    authority: string | undefined,
    timeoutMs: number,
  ): Promise<number | undefined>
  /** Phone-uploaded attachments, scoped to the authenticated device. */
  attachments?: MobileGatewayAttachmentResolver
}

/** Per-command audit sink; the server adds device identity and owns the file. */
export interface MobileCommandAudit {
  record(action: string, result: 'success' | 'failure', detail?: string): void
}

interface CommandOutcome {
  readonly ok: boolean
  readonly result?: unknown
  readonly error?: MobileErrorCode
}

/** How long a repeated idempotency key returns the first result. */
export const COMMAND_IDEMPOTENCY_TTL_MS = 5 * 60 * 1000
export const SEND_PROMPT_TIMEOUT_MS = 15_000
/**
 * Total budget for open + renderer-ready + create. Stays below the phone's 30s
 * command timeout so the phone receives the real error instead of a timeout.
 */
export const NEW_SESSION_TIMEOUT_MS = 25_000
const NEW_SESSION_BRIDGE_TIMEOUT_MS = 30_000
/** A ping sent before the renderer's listener exists never settles; cap each try. */
const BRIDGE_PING_TIMEOUT_MS = 500
const BRIDGE_PING_INTERVAL_MS = 100
/** Inbox snapshot: bound each window's readiness wait and list call. */
const INBOX_WINDOW_READY_TIMEOUT_MS = 5_000
const INBOX_LIST_TIMEOUT_MS = 5_000
/** Session subscribe: a snapshot requested before the renderer answers is lost. */
const SESSION_READY_TIMEOUT_MS = 10_000
/** List agents: also bound by the phone's own 10s command timeout. */
const LIST_AGENTS_TIMEOUT_MS = 10_000
/** Fork / rewind / side-task commands wait on an agent fork RPC plus a resume. */
const LONG_COMMAND_TIMEOUT_MS = 120_000
const PREVIEW_REWIND_TIMEOUT_MS = 30_000
const LIST_SIDE_TASKS_TIMEOUT_MS = 10_000

const MUTATING_COMMAND_KINDS: ReadonlySet<string> = new Set([
  'sendPrompt',
  'cancelTurn',
  'resolvePermission',
  'cancelPermission',
  'resolveElicitation',
  'setConfigOption',
  'pauseAutoResolve',
  'resumeAutoResolve',
  'newSession',
  'renameSession',
  'deleteSession',
  'forkSession',
  'rewindSession',
  'createSideTask',
  'openSideTask',
  'deleteSideTask',
])

const sessionKey = (windowId: number, localId: string): string => `${windowId}:${localId}`

export class MobileGatewayHub {
  private readonly _windows = new Map<number, WindowEntry>()
  private readonly _connections = new Set<HubConnectionState>()
  private readonly _inboxState = new Map<string, InboxEntry>()
  /** `windowId:localId:requestId` → optionId → allowedOnMobile (gateway-side re-validation). */
  private readonly _permissionOptions = new Map<string, ReadonlyMap<string, boolean>>()
  private readonly _idempotentResults = new Map<
    string,
    { readonly outcome: CommandOutcome; readonly expiresAt: number }
  >()
  private readonly _inflightCommands = new Map<string, Promise<CommandOutcome>>()
  private _inboxSeq = 0
  private _streaming = false
  private _attention = false

  constructor(
    private readonly _logger: ILogger,
    private readonly _host?: MobileGatewayHost,
    private readonly _onAttention?: (attention: MobileGatewayAttention) => void,
  ) {}

  registerWindow(
    windowId: number,
    bridge: IMobileBridgeService,
    workspaceName: () => string = () => '',
  ): void {
    this.unregisterWindow(windowId)
    const entry: WindowEntry = {
      windowId,
      bridge,
      workspaceName,
      subscription: undefined,
      streaming: false,
      attention: false,
      rendererReady: false,
      readyProbe: undefined,
    }
    this._windows.set(windowId, entry)
    this._syncWindow(entry)
  }

  unregisterWindow(windowId: number): void {
    const entry = this._windows.get(windowId)
    if (entry === undefined) return
    this._windows.delete(windowId)
    this._disposeWindowWatch(entry)

    const removes: MobileSessionRef[] = []
    for (const [key, value] of this._inboxState) {
      if (value.windowId !== windowId) continue
      this._inboxState.delete(key)
      removes.push(value.summary.ref)
    }
    for (const state of this._connections) {
      for (const [key, subscription] of state.sessions) {
        if (subscription.windowId !== windowId) continue
        subscription.cancelled = true
        state.sessions.delete(key)
        this._send(
          state.connection,
          { type: 'session_removed', ref: subscription.ref },
          subscription.localId,
        )
      }
    }
    if (removes.length > 0) this._broadcastInboxDelta([], removes)
    this._updateStreaming()
  }

  dispose(): void {
    for (const entry of this._windows.values()) {
      this._disposeWindowWatch(entry)
    }
    this._windows.clear()
    this._connections.clear()
    this._inboxState.clear()
    this._streaming = false
    this._attention = false
  }

  /**
   * Attention-only listening is cheap: no timeline serialization, no inbox
   * snapshots, just the shared edge signal. Main turns it on while at least one
   * paired device has notifications enabled — the phone may be in the
   * background with no inbox subscriber at all.
   */
  setAttentionNeeded(needed: boolean): void {
    if (this._attention === needed) return
    this._attention = needed
    for (const entry of this._windows.values()) this._syncWindow(entry)
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
      this._send(connection, { type: 'session_removed', ref }, ref.localId)
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
      this._send(connection, { type: 'session_removed', ref }, ref.localId)
      return
    }
    const deadline = Date.now() + SESSION_READY_TIMEOUT_MS
    if (!(await this._ensureWindowReady(entry, deadline))) {
      // Unregister already removed the subscription and sent its own frame.
      if (subscription.cancelled || state.sessions.get(key) !== subscription) return
      this._logger.warn(
        `mobile snapshot skipped: window ${resolved.windowId} renderer never answered`,
      )
      state.sessions.delete(key)
      this._send(connection, { type: 'session_removed', ref }, ref.localId)
      return
    }
    if (subscription.cancelled || state.sessions.get(key) !== subscription) return
    let snapshot: Awaited<ReturnType<IMobileBridgeService['getSnapshot']>>
    try {
      snapshot = await callWithToken(
        (token) => entry.bridge.getSnapshot(resolved.localId, token),
        Math.max(1, deadline - Date.now()),
      )
    } catch (err) {
      this._logger.warn(`mobile snapshot failed: ${String(err)}`)
      snapshot = undefined
    }
    // Unsubscribe / re-subscribe / window close may have replaced the entry
    // while the snapshot was in flight; the newer request owns the output.
    if (subscription.cancelled || state.sessions.get(key) !== subscription) return
    if (snapshot === undefined) {
      state.sessions.delete(key)
      this._send(connection, { type: 'session_removed', ref }, ref.localId)
      return
    }

    const summary = this._toProtocolSummary(entry, snapshot.summary)
    if (snapshot.pendingPermission !== undefined) {
      this._cachePermission(resolved.windowId, summary.ref.localId, snapshot.pendingPermission)
    }
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
    this._send(connection, frame, resolved.localId)
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
    const target = key ?? sessionKey(ref.windowId, ref.localId)
    const subscription = state.sessions.get(target)
    if (subscription !== undefined) subscription.cancelled = true
    state.sessions.delete(target)
    this._updateStreaming()
  }

  async handleCommand(
    connection: MobileGatewayHubConnection,
    frame: CommandFrame,
    audit?: MobileCommandAudit,
    context?: { readonly deviceId?: string },
  ): Promise<void> {
    const mutating = MUTATING_COMMAND_KINDS.has(frame.kind)
    const cacheKey =
      frame.idempotencyKey !== undefined && mutating ? frame.idempotencyKey : undefined
    let outcome: CommandOutcome
    if (cacheKey !== undefined) {
      const now = Date.now()
      const cached = this._idempotentResults.get(cacheKey)
      if (cached !== undefined && cached.expiresAt > now) {
        outcome = cached.outcome
      } else {
        if (cached !== undefined) this._idempotentResults.delete(cacheKey)
        const inflight = this._inflightCommands.get(cacheKey)
        if (inflight !== undefined) {
          outcome = await inflight
        } else {
          const run = this._dispatchCommand(frame, context?.deviceId).finally(() => {
            this._inflightCommands.delete(cacheKey)
          })
          this._inflightCommands.set(cacheKey, run)
          outcome = await run
          this._idempotentResults.set(cacheKey, {
            outcome,
            expiresAt: Date.now() + COMMAND_IDEMPOTENCY_TTL_MS,
          })
          this._pruneIdempotency()
        }
      }
    } else {
      outcome = await this._dispatchCommand(frame, context?.deviceId)
    }

    if (audit !== undefined && mutating) {
      const ref = (frame.payload as { ref?: MobileSessionRef }).ref
      const parts: string[] = []
      if (ref !== undefined) {
        parts.push(`window=${ref.windowId}`, `local=${ref.localId}`)
      }
      if (frame.kind === 'newSession') {
        const agentId = (frame.payload as { agentId?: string }).agentId
        if (agentId !== undefined) parts.push(`agent=${agentId}`)
      }
      if (!outcome.ok && outcome.error !== undefined) parts.push(`error=${outcome.error}`)
      audit.record(
        frame.kind,
        outcome.ok ? 'success' : 'failure',
        parts.length > 0 ? parts.join(' ') : undefined,
      )
    }

    if (outcome.ok) {
      this._send(connection, {
        type: 'command_result',
        requestId: frame.requestId,
        ok: true,
        ...(outcome.result !== undefined ? { result: outcome.result } : {}),
      })
    } else {
      this._send(connection, {
        type: 'command_result',
        requestId: frame.requestId,
        ok: false,
        error: outcome.error ?? 'internal',
      })
    }
  }

  private async _dispatchCommand(
    frame: CommandFrame,
    deviceId: string | undefined,
  ): Promise<CommandOutcome> {
    const payload = frame.payload as { ref?: MobileSessionRef }
    switch (frame.kind) {
      case 'getToolCallDetail': {
        const detailPayload = frame.payload as { ref: MobileSessionRef; toolCallId: string }
        const resolved = this._resolveSession(detailPayload.ref)
        if (resolved === undefined) return failOutcome('session_not_found')
        const entry = this._windows.get(resolved.windowId)
        if (entry === undefined) return failOutcome('session_not_found')
        try {
          const detail = await entry.bridge.getToolCallDetail(
            resolved.localId,
            detailPayload.toolCallId,
          )
          return detail === undefined
            ? failOutcome('session_not_found')
            : { ok: true, result: detail }
        } catch (err) {
          this._logger.warn(`mobile command getToolCallDetail failed: ${String(err)}`)
          return failOutcome('internal')
        }
      }
      case 'sendPrompt': {
        const p = frame.payload as {
          ref: MobileSessionRef
          text: string
          attachmentIds?: readonly string[]
        }
        const ids = p.attachmentIds ?? []
        let attachments: readonly MobileBridgePromptAttachment[] | undefined
        if (ids.length > 0) {
          if (deviceId === undefined) return failOutcome('unauthorized')
          const resolver = this._host?.attachments
          if (resolver === undefined) return failOutcome('not_supported')
          try {
            attachments = await resolver.resolveForPrompt(deviceId, ids)
          } catch (err) {
            if (err instanceof MobileAttachmentError) return failOutcome(err.code)
            throw err
          }
        }
        const outcome = await this._sessionCommand(p.ref, SEND_PROMPT_TIMEOUT_MS, (bridge, localId) =>
          attachments === undefined
            ? bridge.sendPrompt(localId, p.text)
            : bridge.sendPrompt(localId, p.text, attachments),
        )
        if (outcome.ok && ids.length > 0 && deviceId !== undefined) {
          const resolver = this._host?.attachments
          void resolver?.consume(deviceId, ids).catch((err: unknown) => {
            this._logger.warn(`mobile attachment consume failed: ${String(err)}`)
          })
        }
        return outcome
      }
      case 'cancelTurn': {
        const p = frame.payload as { ref: MobileSessionRef }
        return this._sessionCommand(p.ref, 5000, (bridge, localId) => bridge.cancelTurn(localId))
      }
      case 'resolvePermission': {
        const p = frame.payload as {
          ref: MobileSessionRef
          requestId: string
          optionId: string
          feedback?: string
        }
        const resolved = this._resolveSession(p.ref)
        if (resolved === undefined) return failOutcome('session_not_found')
        const allowed = this._permissionOptions.get(
          permissionKey(resolved.windowId, resolved.localId, p.requestId),
        )
        // Second line of defence: the bridge also rejects high-risk options, but
        // the gateway must not route an option it cannot prove was offered.
        const allowedForOption = allowed?.get(p.optionId)
        if (allowedForOption !== true) return failOutcome('forbidden_operation')
        return this._withBridge(resolved, 10_000, (bridge) =>
          bridge.resolvePermission(resolved.localId, p.requestId, p.optionId, p.feedback),
        )
      }
      case 'cancelPermission': {
        const p = frame.payload as { ref: MobileSessionRef; requestId: string }
        return this._sessionCommand(p.ref, 10_000, (bridge, localId) =>
          bridge.cancelPermission(localId, p.requestId),
        )
      }
      case 'resolveElicitation': {
        const p = frame.payload as {
          ref: MobileSessionRef
          requestId: string
          action: 'accept' | 'decline' | 'cancel'
          content?: Record<string, string | number | boolean | string[]>
        }
        return this._sessionCommand(p.ref, 10_000, (bridge, localId) =>
          bridge.resolveElicitation(localId, p.requestId, p.action, p.content),
        )
      }
      case 'setConfigOption': {
        const p = frame.payload as {
          ref: MobileSessionRef
          configId: string
          value: string | boolean
        }
        if (!isConfigValueAllowedOnMobile(p.value)) return failOutcome('forbidden_operation')
        return this._sessionCommand(p.ref, 10_000, (bridge, localId) =>
          bridge.setConfigOption(localId, p.configId, p.value),
        )
      }
      case 'pauseAutoResolve': {
        const p = frame.payload as { ref: MobileSessionRef; requestId: string }
        return this._sessionCommand(p.ref, 10_000, (bridge, localId) =>
          bridge.pauseAutoResolve(localId, p.requestId),
        )
      }
      case 'resumeAutoResolve': {
        const p = frame.payload as { ref: MobileSessionRef; requestId: string }
        return this._sessionCommand(p.ref, 10_000, (bridge, localId) =>
          bridge.resumeAutoResolve(localId, p.requestId),
        )
      }
      case 'newSession': {
        const p = frame.payload as {
          agentId: string
          workspace: { folder: string; authority?: string }
          initialPrompt?: string
        }
        return this._newSession(p)
      }
      case 'renameSession': {
        const p = frame.payload as { ref: MobileSessionRef; title: string }
        return this._sessionCommand(p.ref, 10_000, (bridge, localId) =>
          bridge.renameSession(localId, p.title),
        )
      }
      case 'deleteSession': {
        const p = frame.payload as { ref: MobileSessionRef }
        return this._sessionCommand(p.ref, 30_000, (bridge, localId) =>
          bridge.deleteSession(localId),
        )
      }
      case 'forkSession': {
        const p = frame.payload as { ref: MobileSessionRef; messageId?: string }
        return this._sessionRefCommand(p.ref, LONG_COMMAND_TIMEOUT_MS, (bridge, localId) =>
          bridge.forkSession(localId, p.messageId),
        )
      }
      case 'previewRewind': {
        const p = frame.payload as { ref: MobileSessionRef; messageId: string }
        return this._sessionCommand(p.ref, PREVIEW_REWIND_TIMEOUT_MS, (bridge, localId) =>
          bridge.previewRewind(localId, p.messageId),
        )
      }
      case 'rewindSession': {
        const p = frame.payload as {
          ref: MobileSessionRef
          messageId: string
          rewindFiles?: boolean
        }
        return this._sessionCommand(p.ref, LONG_COMMAND_TIMEOUT_MS, (bridge, localId) =>
          bridge.rewindSession(localId, p.messageId, p.rewindFiles),
        )
      }
      case 'createSideTask': {
        const p = frame.payload as { ref: MobileSessionRef; quote?: string }
        return this._sessionRefCommand(p.ref, LONG_COMMAND_TIMEOUT_MS, (bridge, localId) =>
          bridge.createSideTask(localId, p.quote),
        )
      }
      case 'listSideTasks': {
        const p = frame.payload as { ref: MobileSessionRef }
        const outcome = await this._sessionCommand(
          p.ref,
          LIST_SIDE_TASKS_TIMEOUT_MS,
          (bridge, localId) => bridge.listSideTasks(localId),
        )
        return outcome.ok ? { ok: true, result: clampSideTaskSummaries(outcome.result) } : outcome
      }
      case 'openSideTask': {
        const p = frame.payload as { ref: MobileSessionRef; sideTaskId: string }
        return this._sessionRefCommand(p.ref, LONG_COMMAND_TIMEOUT_MS, (bridge, localId) =>
          bridge.openSideTask(localId, p.sideTaskId),
        )
      }
      case 'deleteSideTask': {
        const p = frame.payload as { ref: MobileSessionRef; sideTaskId: string }
        return this._sessionCommand(p.ref, LONG_COMMAND_TIMEOUT_MS, (bridge, localId) =>
          bridge.deleteSideTask(localId, p.sideTaskId),
        )
      }
      case 'listWorkspaces':
        return this._listWorkspaces()
      case 'listAgents':
        return this._listAgents()
      default:
        // Unknown kinds still reach here through a newer phone; payload carried
        // through validation unchanged.
        void payload
        return failOutcome('not_supported')
    }
  }

  private async _sessionCommand(
    ref: MobileSessionRef,
    timeoutMs: number,
    call: (bridge: IMobileBridgeService, localId: string) => Promise<MobileBridgeResult<unknown>>,
  ): Promise<CommandOutcome> {
    const resolved = this._resolveSession(ref)
    if (resolved === undefined) return failOutcome('session_not_found')
    return this._withBridge(resolved, timeoutMs, (bridge) => call(bridge, resolved.localId))
  }

  /**
   * Like `_sessionCommand`, but the bridge result is a renderer-local session
   * ref: main stamps `windowId` so the phone can address the new session.
   */
  private async _sessionRefCommand(
    ref: MobileSessionRef,
    timeoutMs: number,
    call: (
      bridge: IMobileBridgeService,
      localId: string,
    ) => Promise<MobileBridgeResult<MobileBridgeNewSessionResult>>,
  ): Promise<CommandOutcome> {
    const resolved = this._resolveSession(ref)
    if (resolved === undefined) return failOutcome('session_not_found')
    const outcome = await this._withBridge(resolved, timeoutMs, (bridge) =>
      call(bridge, resolved.localId),
    )
    if (!outcome.ok) return outcome
    if (!isBridgeNewSessionResult(outcome.result)) {
      this._logger.warn('mobile bridge returned an invalid session ref')
      return failOutcome('internal')
    }
    const value = outcome.result
    const created: MobileNewSessionResult = {
      ref: {
        windowId: resolved.windowId,
        localId: value.localId,
        ...(value.durableId !== undefined ? { durableId: value.durableId } : {}),
      },
    }
    return { ok: true, result: created }
  }

  private async _withBridge(
    resolved: { windowId: number; localId: string },
    timeoutMs: number,
    call: (bridge: IMobileBridgeService) => Promise<MobileBridgeResult<unknown>>,
  ): Promise<CommandOutcome> {
    const entry = this._windows.get(resolved.windowId)
    if (entry === undefined) return failOutcome('session_not_found')
    try {
      const result = await withTimeout(call(entry.bridge), timeoutMs)
      return result.ok ? { ok: true, result: result.value } : { ok: false, error: result.code }
    } catch (err) {
      this._logger.warn(`mobile command failed: ${String(err)}`)
      return failOutcome('internal')
    }
  }

  private async _newSession(payload: {
    agentId: string
    workspace: { folder: string; authority?: string }
    initialPrompt?: string
  }): Promise<CommandOutcome> {
    const open = this._host?.listOpenWorkspaces() ?? []
    const recent = (await this._host?.listRecentWorkspaces().catch(() => [])) ?? []
    const openMatch = open.find((candidate) => isSameWorkspace(candidate, payload.workspace))
    const recentMatch = recent.find((candidate) => isSameWorkspace(candidate, payload.workspace))
    const target = openMatch ?? recentMatch
    if (target === undefined) return failOutcome('workspace_not_open')

    const authority = payload.workspace.authority ?? target.authority
    const remote = isRemoteWorkspace(payload.workspace.folder, authority)
    // Remote sessions cannot be started by opening a local window; an already
    // open remote window is required.
    if (remote && openMatch === undefined) return failOutcome('workspace_not_open')

    const deadline = Date.now() + NEW_SESSION_TIMEOUT_MS
    let windowId = openMatch?.windowId
    if (windowId === undefined || !this._windows.has(windowId)) {
      if (openMatch === undefined) {
        const host = this._host
        try {
          if (host !== undefined) {
            await withTimeout(
              host.openWorkspace(payload.workspace.folder, authority),
              Math.max(1, deadline - Date.now()),
            )
          }
        } catch (err) {
          this._logger.warn(`mobile newSession openWorkspace failed: ${String(err)}`)
          return failOutcome('workspace_not_open')
        }
      }
      windowId = await this._host?.waitForBridge(
        payload.workspace.folder,
        authority,
        Math.max(0, deadline - Date.now()),
      )
    }
    if (windowId === undefined) return failOutcome('workspace_not_open')
    const entry = this._windows.get(windowId)
    if (entry === undefined) return failOutcome('workspace_not_open')

    // `waitForBridge` only proves main registered the reverse channel. A fresh
    // window's renderer registers its side after the bundle boots, so a command
    // sent now is dropped by the transport and never settles; ping until the
    // renderer actually answers. Also covers a renderer reload.
    if (!(await this._ensureWindowReady(entry, deadline))) {
      this._logger.warn(
        `mobile newSession renderer not ready within ${NEW_SESSION_TIMEOUT_MS}ms (window=${windowId})`,
      )
      return failOutcome('workspace_not_open')
    }

    try {
      const result = await callWithToken(
        (token) =>
          entry.bridge.newSession(
            payload.agentId,
            {
              folder: payload.workspace.folder,
              ...(authority !== undefined ? { authority } : {}),
            },
            payload.initialPrompt ?? null,
            token,
          ),
        Math.max(1, deadline - Date.now()),
      )
      if (!result.ok) return { ok: false, error: result.code }
      const created: MobileNewSessionResult = {
        ref: {
          windowId,
          localId: result.value.localId,
          ...(result.value.durableId !== undefined ? { durableId: result.value.durableId } : {}),
        },
      }
      return { ok: true, result: created }
    } catch (err) {
      this._logger.warn(`mobile newSession failed: ${String(err)}`)
      return failOutcome('internal')
    }
  }

  /**
   * A dropped frame (renderer listener not installed yet) never settles, so
   * each probe is bounded and cancelled on timeout. A failed probe also clears
   * `rendererReady`: a reload kills the old renderer's wiring, and the next
   * successful ping must rebuild it. Retries stop at the shared deadline.
   */
  private async _waitForBridgeReady(entry: WindowEntry, deadline: number): Promise<boolean> {
    while (Date.now() < deadline) {
      if (this._windows.get(entry.windowId) !== entry) return false
      try {
        await callWithToken(
          (token) => entry.bridge.ping(token),
          Math.max(1, Math.min(BRIDGE_PING_TIMEOUT_MS, deadline - Date.now())),
        )
        return true
      } catch {
        // Transport drop, ChannelNotFound, channel disposed, or timeout: retry.
        if (this._windows.get(entry.windowId) === entry) this._markRendererLost(entry)
      }
      const sleepMs = Math.min(BRIDGE_PING_INTERVAL_MS, deadline - Date.now())
      if (sleepMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, sleepMs))
    }
    return false
  }

  /**
   * Probe until the renderer channel answers, then run the deferred wiring on
   * the first success. Used by both the command path and the background sync.
   */
  private async _ensureWindowReady(entry: WindowEntry, deadline: number): Promise<boolean> {
    if (!(await this._waitForBridgeReady(entry, deadline))) return false
    if (this._windows.get(entry.windowId) !== entry) return false
    if (!entry.rendererReady) {
      entry.rendererReady = true
      this._syncWindow(entry)
    }
    return true
  }

  /**
   * A failed probe means the old renderer's event wiring is gone (reload) or
   * never existed. Reset the flags so a later successful probe re-subscribes
   * and re-sends the idempotent streaming/attention toggles; the old renderer
   * is not asked to stop because it may already be gone.
   */
  private _markRendererLost(entry: WindowEntry): void {
    entry.rendererReady = false
    entry.subscription?.dispose()
    entry.subscription = undefined
    entry.streaming = false
    entry.attention = false
  }

  private _startReadyProbe(entry: WindowEntry): void {
    if (entry.readyProbe !== undefined) return
    const probe = this._ensureWindowReady(entry, Date.now() + NEW_SESSION_TIMEOUT_MS)
    entry.readyProbe = probe
    void probe.finally(() => {
      if (entry.readyProbe === probe) entry.readyProbe = undefined
    })
  }

  private async _listWorkspaces(): Promise<CommandOutcome> {
    const open = this._host?.listOpenWorkspaces() ?? []
    const recent = (await this._host?.listRecentWorkspaces().catch(() => [])) ?? []
    const result: MobileWorkspaceCandidate[] = open.map((workspace) => ({
      folder: workspace.folder,
      name: workspace.name,
      ...(workspace.authority !== undefined ? { authority: workspace.authority } : {}),
      isOpen: true,
    }))
    for (const workspace of recent) {
      if (open.some((candidate) => isSameWorkspace(candidate, workspace))) continue
      result.push({
        folder: workspace.folder,
        name: workspace.name,
        ...(workspace.authority !== undefined ? { authority: workspace.authority } : {}),
        isOpen: false,
      })
    }
    return { ok: true, result }
  }

  private async _listAgents(): Promise<CommandOutcome> {
    const entries = [...this._windows.values()]
    // Prefer a renderer that already answered; otherwise probe the first one.
    const entry = entries.find((candidate) => candidate.rendererReady) ?? entries[0]
    if (entry === undefined) return { ok: true, result: [] as MobileAgentCandidate[] }
    try {
      const deadline = Date.now() + LIST_AGENTS_TIMEOUT_MS
      if (!(await this._ensureWindowReady(entry, deadline))) {
        return failOutcome('internal')
      }
      return {
        ok: true,
        result: await callWithToken(
          (token) => entry.bridge.listAgents(token),
          Math.max(1, deadline - Date.now()),
        ),
      }
    } catch (err) {
      this._logger.warn(`mobile listAgents failed: ${String(err)}`)
      return failOutcome('internal')
    }
  }

  private _pruneIdempotency(): void {
    const now = Date.now()
    for (const [key, entry] of this._idempotentResults) {
      if (entry.expiresAt <= now) this._idempotentResults.delete(key)
    }
  }

  private _cachePermission(
    windowId: number,
    localId: string,
    permission: {
      requestId: string
      options: readonly { optionId: string; allowedOnMobile: boolean }[]
    },
  ): void {
    this._permissionOptions.set(
      permissionKey(windowId, localId, permission.requestId),
      new Map(permission.options.map((option) => [option.optionId, option.allowedOnMobile])),
    )
  }

  private _clearPermission(windowId: number, localId: string, requestId: string): void {
    this._permissionOptions.delete(permissionKey(windowId, localId, requestId))
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
    if (event.kind === 'attention') {
      this._handleAttention(windowId, event)
      return
    }
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
    for (const delta of event.events) {
      if (delta.type === 'permission_upsert') {
        this._cachePermission(windowId, event.localId, delta.permission)
      } else if (delta.type === 'permission_cleared') {
        this._clearPermission(windowId, event.localId, delta.requestId)
      }
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

  /**
   * Single outbound exit: a frame the protocol validator would reject must never
   * reach the phone, because the client drops the whole frame (including a
   * snapshot) and would otherwise wait forever.
   */
  private _send(
    connection: MobileGatewayHubConnection,
    frame: ServerFrame,
    sessionId?: string,
  ): void {
    const parsed = parseServerFrame(serializeFrame(frame))
    if (!parsed.ok) {
      this._logger.error(
        `mobile gateway dropped invalid frame type=${frame.type} session=${sessionId ?? '-'}: ${parsed.error.message}`,
      )
      return
    }
    connection.send(frame)
  }

  private _sendSessionEvents(
    state: HubConnectionState,
    subscription: SessionSubscription,
    events: readonly MobileSessionEvent[],
  ): void {
    if (events.length === 0 || subscription.desynced) return
    if (state.connection.bufferedAmount() > MAX_BUFFERED_SESSION_BYTES) {
      subscription.desynced = true
      this._send(
        state.connection,
        {
          type: 'resync_required',
          scope: 'session',
          reason: 'backpressure',
          ref: subscription.ref,
        },
        subscription.localId,
      )
      return
    }
    subscription.seq += 1
    this._send(
      state.connection,
      {
        type: 'session_delta',
        seq: subscription.seq,
        ref: subscription.ref,
        events,
      },
      subscription.localId,
    )
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
      this._send(state.connection, {
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
          try {
            // A window registered before its renderer booted cannot answer.
            // Wait briefly; if it is still booting, leave its rows to the
            // deltas its streaming emits once the readiness probe wires it.
            if (
              !(await this._ensureWindowReady(entry, Date.now() + INBOX_WINDOW_READY_TIMEOUT_MS))
            ) {
              return []
            }
            const summaries = await callWithToken(
              (token) => entry.bridge.listSessions(token),
              INBOX_LIST_TIMEOUT_MS,
            )
            return summaries.map((summary) => this._toProtocolSummary(entry, summary))
          } catch (err) {
            this._logger.warn(
              `mobile inbox snapshot window ${entry.windowId} failed: ${String(err)}`,
            )
            return []
          }
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
    this._send(state.connection, { type: 'inbox_snapshot', seq: ++this._inboxSeq, sessions })
    state.inboxSnapshotPending = false
    const buffered = state.bufferedInbox
    state.bufferedInbox = []
    for (const delta of buffered) {
      this._send(state.connection, {
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
      agentId: clampText(summary.agentId, MAX_ID_LENGTH),
      ...(summary.agentName !== undefined
        ? { agentName: clampText(summary.agentName, MAX_TITLE_LENGTH) }
        : {}),
      title: clampText(summary.title, MAX_TITLE_LENGTH),
      status: clampText(summary.status, MAX_STATUS_LENGTH),
      displayStatus: clampText(summary.displayStatus, MAX_STATUS_LENGTH),
      bucket: summary.bucket,
      workspaceName: this._workspaceName(entry),
      ...(summary.cwd !== undefined
        ? { cwd: clampText(summary.cwd, MAX_WORKSPACE_NAME_LENGTH) }
        : {}),
      ...(summary.authority !== undefined
        ? { authority: clampText(summary.authority, MAX_WORKSPACE_NAME_LENGTH) }
        : {}),
      readOnly: summary.readOnly,
      hasPendingPermission: summary.hasPendingPermission,
      hasPendingElicitation: summary.hasPendingElicitation,
      backgroundTaskCount: summary.backgroundTaskCount,
      ...(summary.imageSupported !== undefined
        ? { imageSupported: summary.imageSupported }
        : {}),
      ...(summary.forkSupported === true ? { forkSupported: true } : {}),
      ...(summary.rewindSupported === true ? { rewindSupported: true } : {}),
      ...(summary.sideTaskOf !== undefined && summary.sideTaskOf.length > 0
        ? { sideTaskOf: clampText(summary.sideTaskOf, MAX_ID_LENGTH) }
        : {}),
      ...(summary.sideTaskChildCount !== undefined &&
      Number.isInteger(summary.sideTaskChildCount) &&
      summary.sideTaskChildCount > 0
        ? { sideTaskChildCount: summary.sideTaskChildCount }
        : {}),
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
      return clampText(entry.workspaceName(), MAX_WORKSPACE_NAME_LENGTH)
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

  private _handleAttention(windowId: number, event: MobileBridgeAttentionEvent): void {
    const cached = this._inboxState.get(sessionKey(windowId, event.localId))?.summary
    this._onAttention?.({
      kind: event.attentionKind,
      ref: {
        windowId,
        localId: event.localId,
        ...(event.durableId !== undefined ? { durableId: event.durableId } : {}),
      },
      title: cached?.title ?? event.title,
      ...(cached?.agentName !== undefined || event.agentName !== undefined
        ? { agentName: cached?.agentName ?? event.agentName }
        : {}),
      ...(event.permissionTitle !== undefined ? { permissionTitle: event.permissionTitle } : {}),
    })
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
    for (const entry of this._windows.values()) this._syncWindow(entry)
  }

  /** Bring one window's bridge subscriptions in line with the two flags. */
  private _syncWindow(entry: WindowEntry): void {
    const active = this._streaming || this._attention
    if (!entry.rendererReady) {
      // Frames sent to a booting renderer are dropped and never replayed, so
      // hold the wiring until a ping proves the channel exists; the probe
      // re-runs this method on success.
      if (active) this._startReadyProbe(entry)
      return
    }
    if (active) {
      // Subscribe only when first needed, not at registerWindow: main registers
      // the window before the renderer has registered its IPC channel.
      entry.subscription ??= entry.bridge.onDidChange((event) =>
        this._handleBridgeEvent(entry.windowId, event),
      )
    } else if (entry.subscription !== undefined) {
      entry.subscription.dispose()
      entry.subscription = undefined
    }

    if (entry.streaming !== this._streaming) {
      entry.streaming = this._streaming
      const call = this._streaming ? entry.bridge.startStreaming() : entry.bridge.stopStreaming()
      void call.catch((err) => {
        this._logger.warn(`mobile bridge streaming toggle failed: ${String(err)}`)
      })
    }

    if (entry.attention !== this._attention) {
      entry.attention = this._attention
      const call = this._attention ? entry.bridge.startAttention() : entry.bridge.stopAttention()
      void call.catch((err) => {
        this._logger.warn(`mobile bridge attention toggle failed: ${String(err)}`)
      })
    }
  }

  private _disposeWindowWatch(entry: WindowEntry): void {
    entry.subscription?.dispose()
    entry.subscription = undefined
    if (entry.streaming) {
      entry.streaming = false
      void entry.bridge.stopStreaming().catch((err) => {
        this._logger.debug(`mobile bridge stop failed: ${String(err)}`)
      })
    }
    if (entry.attention) {
      entry.attention = false
      void entry.bridge.stopAttention().catch((err) => {
        this._logger.debug(`mobile bridge attention stop failed: ${String(err)}`)
      })
    }
  }
}

function serializedLength(frame: unknown): number {
  return JSON.stringify(frame).length
}

function failOutcome(error: MobileErrorCode): CommandOutcome {
  return { ok: false, error }
}

function isBridgeNewSessionResult(value: unknown): value is MobileBridgeNewSessionResult {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  const localId = record['localId']
  const durableId = record['durableId']
  return (
    typeof localId === 'string' &&
    localId.length > 0 &&
    (durableId === undefined || (typeof durableId === 'string' && durableId.length > 0))
  )
}

/** Rebuild the side-task rows so a malformed bridge value cannot poison a frame. */
function clampSideTaskSummaries(value: unknown): readonly MobileSideTaskSummary[] {
  if (!Array.isArray(value)) return []
  const rows: MobileSideTaskSummary[] = []
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    const id = record['id']
    const title = record['title']
    if (typeof id !== 'string' || id.length === 0) continue
    const lastUsedAt = record['lastUsedAt']
    rows.push({
      id: clampText(id, MAX_ID_LENGTH),
      title: clampText(typeof title === 'string' ? title : '', MAX_TITLE_LENGTH),
      lastUsedAt:
        typeof lastUsedAt === 'number' && Number.isFinite(lastUsedAt) ? lastUsedAt : 0,
      live: record['live'] === true,
    })
  }
  return rows
}

function permissionKey(windowId: number, localId: string, requestId: string): string {
  return `${windowId}:${localId}:${requestId}`
}

const HOST_PLATFORM = normalizePlatform(process.platform)

export function isSameWorkspace(
  a: { folder: string; authority?: string },
  b: { folder: string; authority?: string },
): boolean {
  let first: URI
  let second: URI
  try {
    first = URI.parse(a.folder)
    second = URI.parse(b.folder)
  } catch {
    return a.folder === b.folder
  }
  if (first.scheme !== second.scheme) return false
  if ((a.authority ?? first.authority) !== (b.authority ?? second.authority)) return false
  return arePathsEqual(first.fsPath, second.fsPath, HOST_PLATFORM)
}

function isRemoteWorkspace(folder: string, authority: string | undefined): boolean {
  if (authority !== undefined && authority !== '') return true
  try {
    return URI.parse(folder).scheme === REMOTE_SCHEME
  } catch {
    return false
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`mobile command timed out after ${timeoutMs}ms`)),
      timeoutMs,
    )
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/**
 * Bound a bridge call and cancel it on timeout. Cancelling releases the channel
 * client's pending request instead of leaving it until the window closes; a
 * cancel after success is a no-op because the listener is already removed.
 */
function callWithToken<T>(
  call: (token: CancellationToken) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  const cts = new CancellationTokenSource()
  return withTimeout(call(cts.token), timeoutMs).finally(() => {
    cts.cancel()
    cts.dispose()
  })
}
