/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Reverse mobile channel, renderer side. Projects this window's ACP sessions into
 *  the window-independent bridge DTOs and streams coalesced delta events to the
 *  main gateway. Everything is lazy: until `startStreaming()` runs (the first
 *  phone subscribed to the inbox) this service sets up no watchers and performs
 *  no serialization, so a PC with no phone pays nothing.
 *--------------------------------------------------------------------------------------------*/

import {
  autorun,
  Emitter,
  ILoggerService,
  type IDisposable,
  type ILogger,
  type IReader,
} from '@universe-editor/platform'
import type { MobileToolCallDetail } from '@universe-editor/mobile-protocol'
import { truncateDiffSideText, truncateToolTextBlock } from '@universe-editor/acp-view-model'
import type {
  MobileBridgeEvent,
  MobileBridgeSessionDelta,
  MobileBridgeSessionEvent,
  MobileBridgeSessionSnapshot,
  MobileBridgeSessionSummary,
  IMobileBridgeService,
} from '../../../shared/ipc/mobileGatewayService.js'
import { IAcpSessionService } from '../acp/session/acpSessionService.js'
import { IAcpSessionHistoryService } from '../acp/session/acpSessionHistory.js'
import { isResidentLive } from '../acp/session/acpSessionStatus.js'
import type { IAcpSession } from '../acp/session/acpSession.js'
import { IAcpAgentRegistry } from '../acp/acpAgentRegistry.js'
import {
  diffConfigOptions,
  diffElicitation,
  diffPermission,
  diffPlan,
  diffTimeline,
  summaryChanged,
  toBridgeSnapshot,
} from './mobileBridgeProjection.js'

/** Coalescing window for ordinary session updates. */
export const MOBILE_BRIDGE_THROTTLE_MS = 50
/** Slower window while one message grows by more than {@link MOBILE_BRIDGE_LARGE_DELTA_CHARS}. */
export const MOBILE_BRIDGE_LARGE_THROTTLE_MS = 100
export const MOBILE_BRIDGE_LARGE_DELTA_CHARS = 64 * 1024

interface SessionStream {
  readonly localId: string
  readonly session: IAcpSession
  watcher: IDisposable | undefined
  timer: ReturnType<typeof setTimeout> | undefined
  timerDelay: number
  disposed: boolean
  pending: MobileBridgeSessionSnapshot | undefined
  publishedTimeline: MobileBridgeSessionSnapshot['timeline']
  publishedPlan: MobileBridgeSessionSnapshot['plan']
  publishedConfigOptions: MobileBridgeSessionSnapshot['configOptions']
  publishedPermission: MobileBridgeSessionSnapshot['pendingPermission']
  publishedElicitation: MobileBridgeSessionSnapshot['pendingElicitation']
  publishedSummary: MobileBridgeSessionSummary | undefined
  publishedMessageChars: number
}

export class MobileBridgeService implements IMobileBridgeService, IDisposable {
  declare readonly _serviceBrand: undefined

  private readonly _onDidChange = new Emitter<MobileBridgeEvent>()
  readonly onDidChange = this._onDidChange.event

  private readonly _logger: ILogger
  private _streaming = false
  private _rootWatcher: IDisposable | undefined
  private _syncScheduled = false
  private _syncHandle: ReturnType<typeof setTimeout> | undefined
  private readonly _streams = new Map<string, SessionStream>()
  private readonly _agentNames = new Map<string, string | undefined>()
  private _disposed = false

  constructor(
    @IAcpSessionService private readonly _sessions: IAcpSessionService,
    @IAcpSessionHistoryService private readonly _history: IAcpSessionHistoryService,
    @IAcpAgentRegistry private readonly _agents: IAcpAgentRegistry,
    @ILoggerService loggerService: ILoggerService,
  ) {
    this._logger = loggerService.createLogger({ id: 'mobileBridge', name: 'Mobile Bridge' })
  }

  ping(): Promise<'pong'> {
    return Promise.resolve('pong')
  }

  async listSessions(): Promise<readonly MobileBridgeSessionSummary[]> {
    const summaries: MobileBridgeSessionSummary[] = []
    for (const session of this._sessions.sessions.get()) {
      if (!isResidentLive(session)) continue
      summaries.push(this._summaryFor(session))
    }
    return summaries
  }

  async getSnapshot(localId: string): Promise<MobileBridgeSessionSnapshot | undefined> {
    const session = this._sessions.getById(localId)
    if (session === undefined || !isResidentLive(session)) return undefined
    // Emit any coalesced delta first so the caller cannot receive an event that
    // precedes this snapshot but describes state the snapshot already carries.
    const stream = this._streams.get(session.id)
    if (stream !== undefined) this._flush(stream)
    return toBridgeSnapshot(session, this._projectionOptions(session))
  }

  async startStreaming(): Promise<void> {
    if (this._disposed || this._streaming) return
    this._streaming = true
    this._logger.debug('mobile bridge streaming started')
    this._rootWatcher = autorun((r) => {
      void this._sessions.sessions.read(r)
      this._scheduleSync()
    })
    this._syncNow()
  }

  async stopStreaming(): Promise<void> {
    if (!this._streaming) return
    this._streaming = false
    this._logger.debug('mobile bridge streaming stopped')
    this._rootWatcher?.dispose()
    this._rootWatcher = undefined
    if (this._syncHandle !== undefined) {
      clearTimeout(this._syncHandle)
      this._syncHandle = undefined
    }
    this._syncScheduled = false
    for (const stream of this._streams.values()) this._disposeStream(stream)
    this._streams.clear()
  }

  async getToolCallDetail(
    localId: string,
    toolCallId: string,
  ): Promise<MobileToolCallDetail | undefined> {
    const session = this._sessions.getById(localId)
    if (session === undefined) return undefined
    const call = session.toolCalls.get().find((candidate) => candidate.id === toolCallId)
    if (call === undefined) return undefined
    return {
      id: call.id,
      title: call.title,
      kind: call.kind,
      status: call.status,
      text: truncateToolTextBlock(call.text),
      diffs: call.diffs.map((diff) => ({
        path: diff.path,
        oldText: truncateDiffSideText(diff.oldText),
        newText: truncateDiffSideText(diff.newText),
      })),
      ...(call.locations !== undefined && call.locations.length > 0
        ? { locations: call.locations.slice(0, 256) }
        : {}),
      ...(call.memoryTrimmed ? { memoryTrimmed: true } : {}),
    }
  }

  dispose(): void {
    if (this._disposed) return
    this._disposed = true
    void this.stopStreaming()
    this._onDidChange.dispose()
  }

  private _scheduleSync(): void {
    if (this._syncScheduled || !this._streaming) return
    this._syncScheduled = true
    // Deferred so a new per-session autorun is never created inside the root
    // autorun's own tracking context.
    this._syncHandle = setTimeout(() => {
      this._syncHandle = undefined
      this._syncScheduled = false
      this._syncNow()
    }, 0)
  }

  private _syncNow(): void {
    if (!this._streaming) return
    const wanted = new Map<string, IAcpSession>()
    for (const session of this._sessions.sessions.get()) {
      if (isResidentLive(session)) wanted.set(session.id, session)
    }

    const removes: { localId: string; durableId?: string }[] = []
    for (const [localId, stream] of this._streams) {
      if (wanted.has(localId)) continue
      const durableId = stream.session.sessionIdOnAgent.get()
      removes.push({ localId, ...(durableId !== undefined ? { durableId } : {}) })
      this._disposeStream(stream)
      this._streams.delete(localId)
      this._logger.debug(`mobile bridge dropped session ${localId}`)
    }
    if (removes.length > 0) this._emit({ kind: 'inbox', upserts: [], removes })

    for (const [localId, session] of wanted) {
      if (this._streams.has(localId)) continue
      this._createStream(session)
      this._logger.debug(`mobile bridge watching session ${localId}`)
    }
  }

  private _createStream(session: IAcpSession): void {
    const stream: SessionStream = {
      localId: session.id,
      session,
      watcher: undefined,
      timer: undefined,
      timerDelay: MOBILE_BRIDGE_THROTTLE_MS,
      disposed: false,
      pending: undefined,
      publishedTimeline: [],
      publishedPlan: [],
      publishedConfigOptions: [],
      publishedPermission: undefined,
      publishedElicitation: undefined,
      publishedSummary: undefined,
      publishedMessageChars: 0,
    }
    this._streams.set(session.id, stream)
    stream.watcher = autorun((r) => {
      if (stream.disposed) return
      const snapshot = toBridgeSnapshot(session, this._projectionOptions(session, r), r)
      stream.pending = snapshot
      this._scheduleFlush(stream, snapshot)
    })
    if (stream.pending !== undefined) this._scheduleFlush(stream, stream.pending)
  }

  private _scheduleFlush(stream: SessionStream, snapshot: MobileBridgeSessionSnapshot): void {
    const delay = this._delayFor(stream, snapshot)
    if (stream.timer !== undefined) {
      if (delay <= stream.timerDelay) return
      clearTimeout(stream.timer)
    }
    stream.timerDelay = delay
    stream.timer = setTimeout(() => {
      stream.timer = undefined
      this._flush(stream)
    }, delay)
  }

  private _delayFor(stream: SessionStream, snapshot: MobileBridgeSessionSnapshot): number {
    let totalChars = 0
    for (const item of snapshot.timeline) {
      if (item.kind === 'message') totalChars += item.text.length
    }
    return totalChars - stream.publishedMessageChars > MOBILE_BRIDGE_LARGE_DELTA_CHARS
      ? MOBILE_BRIDGE_LARGE_THROTTLE_MS
      : MOBILE_BRIDGE_THROTTLE_MS
  }

  private _flush(stream: SessionStream): void {
    if (stream.disposed || stream.pending === undefined) return
    if (stream.timer !== undefined) {
      clearTimeout(stream.timer)
      stream.timer = undefined
    }
    const next = stream.pending
    stream.pending = undefined

    const events: MobileBridgeSessionEvent[] = []
    const timelineDiff = diffTimeline(stream.publishedTimeline, next.timeline)
    events.push(...timelineDiff.events)
    const planEvent = diffPlan(stream.publishedPlan, next.plan)
    if (planEvent !== undefined) events.push(planEvent)
    const configEvent = diffConfigOptions(stream.publishedConfigOptions, next.configOptions)
    if (configEvent !== undefined) events.push(configEvent)
    const permissionEvent = diffPermission(stream.publishedPermission, next.pendingPermission)
    if (permissionEvent !== undefined) events.push(permissionEvent)
    const elicitationEvent = diffElicitation(stream.publishedElicitation, next.pendingElicitation)
    if (elicitationEvent !== undefined) events.push(elicitationEvent)
    const summaryChangedNow =
      stream.publishedSummary !== undefined
        ? summaryChanged(stream.publishedSummary, next.summary)
        : false
    if (summaryChangedNow) {
      events.push({ type: 'summary_changed', summary: next.summary })
    }

    if (events.length > 0) {
      const delta: MobileBridgeSessionDelta = {
        kind: 'session_delta',
        localId: stream.localId,
        events,
      }
      this._emit(delta)
    }

    if (stream.publishedSummary === undefined || summaryChangedNow) {
      this._emit({ kind: 'inbox', upserts: [next.summary], removes: [] })
    }

    stream.publishedTimeline = next.timeline
    stream.publishedPlan = next.plan
    stream.publishedConfigOptions = next.configOptions
    stream.publishedPermission = next.pendingPermission
    stream.publishedElicitation = next.pendingElicitation
    stream.publishedSummary = next.summary
    stream.publishedMessageChars = next.timeline.reduce(
      (sum, item) => (item.kind === 'message' ? sum + item.text.length : sum),
      0,
    )
  }

  private _disposeStream(stream: SessionStream): void {
    stream.disposed = true
    if (stream.timer !== undefined) {
      clearTimeout(stream.timer)
      stream.timer = undefined
    }
    stream.watcher?.dispose()
    stream.watcher = undefined
    stream.pending = undefined
  }

  private _emit(event: MobileBridgeEvent): void {
    this._onDidChange.fire(event)
  }

  private _summaryFor(session: IAcpSession): MobileBridgeSessionSummary {
    return toBridgeSnapshot(session, this._projectionOptions(session)).summary
  }

  private _projectionOptions(
    session: IAcpSession,
    r?: IReader,
  ): { title: string; agentName?: string } {
    const title = this._titleFor(session, r)
    const agentName = this._agentNameFor(session.agentId)
    return { title, ...(agentName !== undefined ? { agentName } : {}) }
  }

  private _titleFor(session: IAcpSession, r?: IReader): string {
    const durableId = r ? session.sessionIdOnAgent.read(r) : session.sessionIdOnAgent.get()
    const entries = r ? this._history.entries.read(r) : this._history.entries.get()
    const id = durableId ?? session.id
    for (const entry of entries) {
      if (entry.id === id) return entry.title
    }
    return session.title
  }

  private _agentNameFor(agentId: string): string | undefined {
    if (this._agentNames.has(agentId)) return this._agentNames.get(agentId)
    let name: string | undefined
    try {
      name = this._agents.get(agentId).name
    } catch {
      name = undefined
    }
    this._agentNames.set(agentId, name)
    return name
  }
}
