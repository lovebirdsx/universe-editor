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
  Disposable,
  Emitter,
  IEditorGroupsService,
  ILoggerService,
  IWorkspaceService,
  REMOTE_SCHEME,
  URI,
  type IDisposable,
  type ILogger,
  type IReader,
} from '@universe-editor/platform'
import {
  isConfigValueAllowedOnMobile,
  isHighRiskPermissionOption,
  type MobileAgentCandidate,
  type MobileElicitationAction,
  type MobileElicitationContentValue,
  type MobileWorkspaceCandidate,
  type MobileToolCallDetail,
} from '@universe-editor/mobile-protocol'
import { truncateDiffSideText, truncateToolTextBlock } from '@universe-editor/acp-view-model'
import type {
  MobileBridgeAttentionEvent,
  MobileBridgeCommandError,
  MobileBridgeEvent,
  MobileBridgeNewSessionResult,
  MobileBridgePromptAttachment,
  MobileBridgeResult,
  MobileBridgeSessionDelta,
  MobileBridgeSessionEvent,
  MobileBridgeSessionSnapshot,
  MobileBridgeSessionSummary,
  IMobileBridgeService,
} from '../../../shared/ipc/mobileGatewayService.js'
import { IAcpSessionService } from '../acp/session/acpSessionService.js'
import { IAcpSessionHistoryService } from '../acp/session/acpSessionHistory.js'
import { isResidentLive } from '../acp/session/acpSessionStatus.js'
import {
  createAgentAttentionSignal,
  type AgentAttentionSignal,
} from '../acp/session/agentAttentionSignal.js'
import type {
  AcpPendingPermission,
  AcpPendingElicitation,
  IAcpSession,
} from '../acp/session/acpSession.js'
import { IAcpAgentRegistry } from '../acp/acpAgentRegistry.js'
import type { PromptImage } from '../acp/promptImage.js'
import type { PromptFileAttachment } from '../acp/promptAttachment.js'
import { selectOptionHasValue } from '../acp/configOptionLabel.js'
import { deleteSessionPlan, planSessionRemoval } from '../acp/session/sessionRemoval.js'
import type {
  MobilePermissionSettleReason,
  MobilePermissionSettleSource,
} from '@universe-editor/mobile-protocol'
import {
  diffConfigOptions,
  diffElicitation,
  diffPermission,
  diffPlan,
  diffTimeline,
  summaryChanged,
  toBridgeSnapshot,
  type PermissionClearMetadata,
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
  /** Most recent settle of a permission request, attached to `permission_cleared`. */
  lastPermissionSettle: PermissionClearMetadata | undefined
  settleWatcher: IDisposable | undefined
}

export class MobileBridgeService extends Disposable implements IMobileBridgeService {
  declare readonly _serviceBrand: undefined

  private readonly _onDidChange = new Emitter<MobileBridgeEvent>()
  readonly onDidChange = this._onDidChange.event

  private readonly _logger: ILogger
  private _streaming = false
  private _attention: AgentAttentionSignal | undefined
  private _rootWatcher: IDisposable | undefined
  private _syncScheduled = false
  private _syncHandle: ReturnType<typeof setTimeout> | undefined
  private readonly _streams = new Map<string, SessionStream>()
  private readonly _agentNames = new Map<string, string | undefined>()
  private _attentionSubscription: IDisposable | undefined
  private _disposed = false

  constructor(
    @IAcpSessionService private readonly _sessions: IAcpSessionService,
    @IAcpSessionHistoryService private readonly _history: IAcpSessionHistoryService,
    @IAcpAgentRegistry private readonly _agents: IAcpAgentRegistry,
    @IWorkspaceService private readonly _workspace: IWorkspaceService,
    @IEditorGroupsService private readonly _editorGroups: IEditorGroupsService,
    @ILoggerService loggerService: ILoggerService,
  ) {
    super()
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
    this._rootWatcher = this._register(
      autorun((r) => {
        void this._sessions.sessions.read(r)
        this._scheduleSync()
      }),
    )
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

  async startAttention(): Promise<void> {
    if (this._disposed || this._attention !== undefined) return
    const signal = createAgentAttentionSignal(this._sessions.sessions)
    this._attention = signal
    this._logger.debug('mobile bridge attention started')
    this._attentionSubscription = this._register(
      signal.onDidAttention((event) => {
        this._emit(this._attentionEventFor(event.session, event.kind))
      }),
    )
  }

  async stopAttention(): Promise<void> {
    if (this._attention === undefined) return
    this._logger.debug('mobile bridge attention stopped')
    this._attentionSubscription?.dispose()
    this._attentionSubscription = undefined
    this._attention.dispose()
    this._attention = undefined
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

  async sendPrompt(
    localId: string,
    text: string,
    attachments: readonly MobileBridgePromptAttachment[] = [],
  ): Promise<MobileBridgeResult<void>> {
    const session = this._liveSession(localId)
    if (session === undefined) return fail('session_not_found', 'session is not live')
    if (session.readOnly) return fail('session_read_only', 'session is read-only')
    const images: PromptImage[] = []
    const files: PromptFileAttachment[] = []
    for (const attachment of attachments) {
      if (attachment.kind === 'image') {
        images.push({
          id: attachment.id,
          attachmentId: attachment.id,
          mimeType: attachment.mimeType,
          dataBase64: attachment.dataBase64,
          byteSize: attachment.byteSize,
          name: attachment.name,
        })
      } else {
        if (session.authority !== undefined) {
          return fail(
            'forbidden_operation',
            'remote sessions cannot read files uploaded to this PC',
          )
        }
        files.push({
          id: attachment.id,
          name: attachment.name,
          mimeType: attachment.mimeType,
          byteSize: attachment.byteSize,
          uri: attachment.uri,
        })
      }
    }
    if (images.length > 0 && session.imageSupported.get() !== true) {
      return fail('not_supported', 'this agent does not accept image attachments')
    }
    // Return once the prompt is accepted by the session (append + queue); the
    // actual agent round-trip is intentionally not awaited.
    const dispatch =
      images.length === 0 && files.length === 0
        ? session.sendPrompt(text)
        : session.sendPrompt(text, undefined, undefined, images, files)
    void dispatch.catch((err: unknown) => {
      this._logger.warn(`mobile sendPrompt failed: ${String(err)}`)
    })
    return ok(undefined)
  }

  async cancelTurn(localId: string): Promise<MobileBridgeResult<void>> {
    return this._run(localId, (session) => session.cancelTurn())
  }

  async resolvePermission(
    localId: string,
    requestId: string,
    optionId: string,
    feedback?: string,
  ): Promise<MobileBridgeResult<void>> {
    const session = this._liveSession(localId)
    if (session === undefined) return fail('session_not_found', 'session is not live')
    if (session.readOnly) return fail('session_read_only', 'session is read-only')
    const pending = this._pendingPermission(session, requestId)
    if (pending === undefined)
      return fail('stale_request', 'permission request is no longer pending')
    const option = pending.options.find((candidate) => candidate.optionId === optionId)
    if (option === undefined) return fail('bad_request', 'unknown permission option')
    if (isHighRiskPermissionOption(option)) {
      return fail('forbidden_operation', 'durable permission grants are not allowed from mobile')
    }
    pending.resolveWithSource(optionId, 'mobile', feedback)
    return ok(undefined)
  }

  async cancelPermission(localId: string, requestId: string): Promise<MobileBridgeResult<void>> {
    const session = this._liveSession(localId)
    if (session === undefined) return fail('session_not_found', 'session is not live')
    if (session.readOnly) return fail('session_read_only', 'session is read-only')
    const pending = this._pendingPermission(session, requestId)
    if (pending === undefined)
      return fail('stale_request', 'permission request is no longer pending')
    pending.cancelWithSource('mobile', 'cancelled')
    return ok(undefined)
  }

  async resolveElicitation(
    localId: string,
    requestId: string,
    action: MobileElicitationAction,
    content?: Record<string, MobileElicitationContentValue>,
  ): Promise<MobileBridgeResult<void>> {
    const session = this._liveSession(localId)
    if (session === undefined) return fail('session_not_found', 'session is not live')
    if (session.readOnly) return fail('session_read_only', 'session is read-only')
    const pending = this._pendingElicitation(session, requestId)
    if (pending === undefined) return fail('stale_request', 'elicitation is no longer pending')
    pending.resolveWithSource(
      action === 'accept' ? { action: 'accept', ...(content ? { content } : {}) } : { action },
      'mobile',
    )
    return ok(undefined)
  }

  async setConfigOption(
    localId: string,
    configId: string,
    value: string | boolean,
  ): Promise<MobileBridgeResult<void>> {
    const session = this._liveSession(localId)
    if (session === undefined) return fail('session_not_found', 'session is not live')
    if (session.readOnly) return fail('session_read_only', 'session is read-only')
    if (!isConfigValueAllowedOnMobile(value)) {
      return fail('forbidden_operation', 'bypass permissions cannot be enabled from mobile')
    }
    const option = session.configOptions.get().find((candidate) => candidate.id === configId)
    if (option === undefined) return fail('bad_request', 'unknown config option')
    if (option.type === 'boolean' && typeof value !== 'boolean') {
      return fail('bad_request', 'boolean config option needs a boolean value')
    }
    if (option.type === 'select') {
      if (typeof value !== 'string' || !selectOptionHasValue(option, value)) {
        return fail('bad_request', 'unknown config value')
      }
    }
    return this._run(localId, (live) => live.setConfigOption(configId, value))
  }

  async pauseAutoResolve(localId: string, requestId: string): Promise<MobileBridgeResult<void>> {
    const session = this._liveSession(localId)
    if (session === undefined) return fail('session_not_found', 'session is not live')
    const pending = this._pendingPermission(session, requestId)
    if (pending?.autoResolve === undefined) {
      return fail('stale_request', 'auto-execute countdown is no longer running')
    }
    if (session.readOnly) return fail('session_read_only', 'session is read-only')
    pending.autoResolve.pause()
    return ok(undefined)
  }

  async resumeAutoResolve(localId: string, requestId: string): Promise<MobileBridgeResult<void>> {
    const session = this._liveSession(localId)
    if (session === undefined) return fail('session_not_found', 'session is not live')
    const pending = this._pendingPermission(session, requestId)
    if (pending?.autoResolve === undefined) {
      return fail('stale_request', 'auto-execute countdown is no longer running')
    }
    if (session.readOnly) return fail('session_read_only', 'session is read-only')
    pending.autoResolve.resume()
    return ok(undefined)
  }

  async newSession(
    agentId: string,
    workspace: { folder: string; authority?: string },
    initialPrompt?: string,
  ): Promise<MobileBridgeResult<MobileBridgeNewSessionResult>> {
    try {
      this._agents.get(agentId)
    } catch {
      return fail('bad_request', 'unknown agent')
    }
    let folder: URI
    try {
      folder = URI.parse(workspace.folder)
    } catch {
      return fail('bad_request', 'invalid workspace folder')
    }
    if (!folder.scheme) return fail('bad_request', 'invalid workspace folder')
    const authority =
      workspace.authority ??
      (folder.scheme === REMOTE_SCHEME && folder.authority ? folder.authority : undefined)
    try {
      const session = await this._sessions.createSession(agentId, {
        cwd: folder.fsPath,
        ...(authority !== undefined ? { authority } : {}),
      })
      if (initialPrompt !== undefined && initialPrompt.length > 0) {
        void session.sendPrompt(initialPrompt).catch((err: unknown) => {
          this._logger.warn(`mobile newSession initial prompt failed: ${String(err)}`)
        })
      }
      const durableId = session.sessionIdOnAgent.get()
      return ok({
        localId: session.id,
        ...(durableId !== undefined ? { durableId } : {}),
      })
    } catch (err) {
      return fail('internal', `failed to create session: ${String(err)}`)
    }
  }

  async renameSession(localId: string, title: string): Promise<MobileBridgeResult<void>> {
    const session = this._liveSession(localId)
    if (session === undefined) return fail('session_not_found', 'session is not live')
    if (session.readOnly) return fail('session_read_only', 'session is read-only')
    session.renameTitle(title)
    return ok(undefined)
  }

  async deleteSession(localId: string): Promise<MobileBridgeResult<void>> {
    const session = this._liveSession(localId)
    if (session === undefined) return fail('session_not_found', 'session is not live')
    if (session.readOnly) return fail('session_read_only', 'session is read-only')
    // Same plan → execute pipeline as the PC "Delete Agent Session" command;
    // the phone already confirmed, so only the execution half runs here.
    const plan = planSessionRemoval(this._sessions, this._history, localId)
    await deleteSessionPlan(plan, this._sessions, this._history, this._editorGroups)
    return ok(undefined)
  }

  async listWorkspaces(): Promise<readonly MobileWorkspaceCandidate[]> {
    const current = this._workspace.current
    if (current === null) return []
    return [
      {
        folder: current.folder.toString(),
        name: current.name,
        ...(current.folder.authority ? { authority: current.folder.authority } : {}),
        isOpen: true,
      },
    ]
  }

  async listAgents(): Promise<readonly MobileAgentCandidate[]> {
    const defaultId = this._agents.defaultAgentId()
    return this._agents.list().map((agent) => ({
      id: agent.id,
      name: agent.name,
      isDefault: agent.id === defaultId,
    }))
  }

  dispose(): void {
    if (this._disposed) return
    this._disposed = true
    void this.stopStreaming()
    void this.stopAttention()
    this._onDidChange.dispose()
    super.dispose()
  }

  private _attentionEventFor(
    session: IAcpSession,
    attentionKind: MobileBridgeAttentionEvent['attentionKind'],
  ): MobileBridgeAttentionEvent {
    const durableId = session.sessionIdOnAgent.get()
    const agentName = this._agentNameFor(session.agentId)
    const permissionTitle = session.pendingPermission.get()?.title
    return {
      kind: 'attention',
      localId: session.id,
      ...(durableId !== undefined ? { durableId } : {}),
      attentionKind,
      title: this._titleFor(session),
      ...(agentName !== undefined ? { agentName } : {}),
      ...(permissionTitle !== undefined && permissionTitle !== '' ? { permissionTitle } : {}),
    }
  }

  private _liveSession(localId: string): IAcpSession | undefined {
    const session = this._sessions.getById(localId)
    return session !== undefined && isResidentLive(session) ? session : undefined
  }

  private _pendingPermission(
    session: IAcpSession,
    requestId: string,
  ): AcpPendingPermission | undefined {
    const pending = session.pendingPermission.get()
    return pending !== undefined && pending.requestId === requestId ? pending : undefined
  }

  private _pendingElicitation(
    session: IAcpSession,
    requestId: string,
  ): AcpPendingElicitation | undefined {
    const pending = session.pendingElicitation.get()
    return pending !== undefined && pending.requestId === requestId ? pending : undefined
  }

  private async _run(
    localId: string,
    action: (session: IAcpSession) => Promise<void>,
  ): Promise<MobileBridgeResult<void>> {
    const session = this._liveSession(localId)
    if (session === undefined) return fail('session_not_found', 'session is not live')
    if (session.readOnly) return fail('session_read_only', 'session is read-only')
    try {
      await action(session)
      return ok(undefined)
    } catch (err) {
      return fail('internal', String(err))
    }
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
      lastPermissionSettle: undefined,
      settleWatcher: undefined,
    }
    this._streams.set(session.id, stream)
    stream.watcher = autorun((r) => {
      if (stream.disposed) return
      const snapshot = toBridgeSnapshot(session, this._projectionOptions(session, r), r)
      if (snapshot.pendingPermission !== undefined) this._ensureSettleWatcher(stream)
      stream.pending = snapshot
      this._scheduleFlush(stream, snapshot)
    })
    if (stream.pending !== undefined) this._scheduleFlush(stream, stream.pending)
  }

  /**
   * Subscribe to settlement events only while a permission is pending: the
   * cleared event needs the reason/source, but an always-on subscription is a
   * disposable the bridge would otherwise keep for the whole session lifetime.
   */
  private _ensureSettleWatcher(stream: SessionStream): void {
    if (stream.settleWatcher !== undefined) return
    stream.settleWatcher = stream.session.onDidSettlePermission((event) => {
      stream.lastPermissionSettle = {
        requestId: event.requestId,
        reason: event.reason as MobilePermissionSettleReason,
        source: event.source as MobilePermissionSettleSource,
      }
    })
  }

  private _dropSettleWatcher(stream: SessionStream): void {
    stream.settleWatcher?.dispose()
    stream.settleWatcher = undefined
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
    const previousPermission = stream.publishedPermission
    const permissionCleared =
      previousPermission !== undefined &&
      next.pendingPermission?.requestId !== previousPermission.requestId &&
      stream.lastPermissionSettle?.requestId === previousPermission.requestId
        ? stream.lastPermissionSettle
        : undefined
    events.push(...diffPermission(previousPermission, next.pendingPermission, permissionCleared))
    if (permissionCleared !== undefined) stream.lastPermissionSettle = undefined
    if (next.pendingPermission === undefined) {
      stream.lastPermissionSettle = undefined
      this._dropSettleWatcher(stream)
    }
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
    this._dropSettleWatcher(stream)
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

function ok<T>(value: T): MobileBridgeResult<T> {
  return { ok: true, value }
}

function fail(code: MobileBridgeCommandError['code'], message: string): MobileBridgeCommandError {
  return { ok: false, code, message }
}
