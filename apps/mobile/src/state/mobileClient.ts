import type {
  ClientFrame,
  CommandFrame,
  MobileAgentCandidate,
  MobileAttachmentKind,
  MobileAttachmentUploadResult,
  MobileCommandKind,
  MobileAttentionKind,
  MobileDeliveryDetail,
  MobileDeliveryExpectation,
  MobileDeliveryPreview,
  MobileDeliveryStartResult,
  MobileDraftFileRef,
  MobileDraftImageRef,
  MobileElicitationAction,
  MobileElicitationContentValue,
  MobileNewSessionResult,
  MobileNotificationPrefs,
  MobilePushBranchExpectation,
  MobilePushBranchPreview,
  MobilePushBranchResult,
  MobilePushSubscription,
  MobileRewindPreview,
  MobileRewindResult,
  MobileSessionHistoryEntry,
  MobileSessionRef,
  MobileSessionRefResult,
  MobileSideTaskSummary,
  MobileToolCallDetail,
  MobileWorkspaceCandidate,
  NotificationFrame,
  ParseError,
  ServerFrame,
  SessionSnapshotFrame,
} from '@universe-editor/mobile-protocol'
import type { StoredCredentials } from '../credentials.js'
import {
  MobileSocket,
  type SocketState,
  type TimerApi,
  type WebSocketLike,
} from '../socket/mobileSocket.js'
import { probeGatewayHealth, type ConnectionDiagnosis } from '../socket/connectionDiagnosis.js'
import { compareWebBuildId, readClientWebBuildId, type WebBuildMismatch } from '../webBuildId.js'
import {
  CommandClient,
  CommandError,
  createCommandId,
  type CommandRequestOptions,
} from './commandClient.js'
import { AttachmentClient, httpOriginForSocketUrl } from './attachmentClient.js'
import {
  isMobileDeliveryDetail,
  isMobileDeliveryPreview,
  isMobileDeliveryStartResult,
  isMobilePushBranchPreview,
  isMobilePushBranchResult,
  isMobileRewindPreview,
  isMobileRewindResult,
  isMobileSessionHistoryList,
  isMobileSessionRefResult,
  isMobileSideTaskList,
} from './commandResults.js'
import { InboxStore, type InboxApplyResult } from './inboxStore.js'
import { parseSessionRouteKey, refMatches, sessionRouteKey } from './refs.js'
import { SessionStore } from './sessionStore.js'
import { Store } from './store.js'
import { ToolCallDetailClient } from './toolCallDetailClient.js'

export interface MobileClientOptions {
  readonly credentials: StoredCredentials
  readonly url: string
  readonly createWebSocket: (url: string) => WebSocketLike
  readonly timers?: TimerApi | undefined
  readonly random?: (() => number) | undefined
  readonly fetchImpl?: typeof fetch | undefined
  readonly onCredentialsInvalid?: (() => void) | undefined
  readonly onProtocolMismatch?: (() => void) | undefined
  /** Overridable for tests; defaults to the module script the page loaded. */
  readonly clientWebBuildId?: string
  readonly logger?: Pick<Console, 'warn'> | undefined
}

/** The gateway treats a broken transport and a bad handshake as the same close. */
export const DIAGNOSE_AFTER_ATTEMPTS = 3
export const DIAGNOSIS_MIN_INTERVAL_MS = 15_000

/**
 * Owns the one WebSocket the phone uses for both the inbox and the currently
 * open session. Frames are folded into pure stores; navigation only changes
 * which session is subscribed, never the connection.
 *
 * Commands all go through the shared {@link CommandClient}; the client-level
 * methods only bind the currently open session's `ref` to the payload.
 */
export class MobileClient {
  private readonly _socket: MobileSocket
  private readonly _socketState = new Store<SocketState>('connecting')
  private readonly _inbox = new InboxStore()
  private readonly _session = new SessionStore()
  private readonly _commands: CommandClient
  private readonly _attachments: AttachmentClient
  private readonly _detail: ToolCallDetailClient
  private readonly _notification = new Store<NotificationFrame | undefined>(undefined)
  private readonly _invalidFrame = new Store<ParseError | undefined>(undefined)
  private readonly _reconnectAttempt = new Store<number>(0)
  private readonly _connectionDiagnosis = new Store<ConnectionDiagnosis | undefined>(undefined)
  private readonly _deviceTrusted = new Store<boolean>(false)
  private readonly _webBuildMismatch = new Store<WebBuildMismatch | undefined>(undefined)
  private readonly _clientWebBuildId: string | undefined
  private readonly _logger: Pick<Console, 'warn'>
  private readonly _timers: TimerApi | undefined
  private readonly _fetchImpl: typeof fetch | undefined
  private readonly _origin: string
  private _diagnosisInFlight = false
  private _lastDiagnosisAt = Number.NEGATIVE_INFINITY
  /** Bumped whenever the socket reaches a terminal/success state; stale probes are dropped. */
  private _connectionEpoch = 0
  private _currentRef: MobileSessionRef | undefined
  private _routeKey: string | undefined
  private _serverTimeOffsetMs = 0
  private _vapidPublicKey: string | undefined
  private _pushSubscription: MobilePushSubscription | undefined
  private _notificationPrefs: MobileNotificationPrefs | undefined

  constructor(options: MobileClientOptions) {
    this._logger = options.logger ?? console
    this._timers = options.timers
    this._fetchImpl = options.fetchImpl
    this._origin = httpOriginForSocketUrl(options.url)
    this._clientWebBuildId = options.clientWebBuildId ?? readClientWebBuildId()
    this._commands = new CommandClient({
      send: (frame) => this._sendCommand(frame),
      timers: options.timers,
    })
    this._attachments = new AttachmentClient({
      origin: this._origin,
      token: options.credentials.token,
      fetchImpl: options.fetchImpl,
      onUnauthorized: options.onCredentialsInvalid,
    })
    this._detail = new ToolCallDetailClient(this._commands)
    this._socket = new MobileSocket({
      url: options.url,
      token: options.credentials.token,
      createWebSocket: options.createWebSocket,
      timers: options.timers,
      random: options.random,
      logger: this._logger,
      onStateChange: (state) => this._handleState(state),
      onFrame: (frame) => this._handleFrame(frame),
      onInvalidFrame: (error) => this._invalidFrame.setState(error),
      onServerTime: (serverTime) => {
        this._serverTimeOffsetMs = serverTime - Date.now()
      },
      onVapidPublicKey: (key) => {
        this._vapidPublicKey = key
      },
      onWebBuildId: (buildId) => {
        this._webBuildMismatch.setState(compareWebBuildId(buildId, this._clientWebBuildId))
      },
      onDeviceTrust: (trusted) => {
        this._deviceTrusted.setState(trusted)
      },
      onCredentialsInvalid: () => {
        this._deviceTrusted.setState(false)
        this._webBuildMismatch.setState(undefined)
        this._inbox.reset()
        this._session.reset()
        options.onCredentialsInvalid?.()
      },
      onProtocolMismatch: options.onProtocolMismatch,
      onReconnectAttempt: (attempt) => this._handleReconnectAttempt(attempt),
    })
  }

  getInboxStore(): InboxStore {
    return this._inbox
  }

  getSessionStore(): SessionStore {
    return this._session
  }

  getSocketStateStore(): Store<SocketState> {
    return this._socketState
  }

  getNotificationStore(): Store<NotificationFrame | undefined> {
    return this._notification
  }

  /** Last frame the gateway sent that failed protocol validation, if any. */
  getInvalidFrameStore(): Store<ParseError | undefined> {
    return this._invalidFrame
  }

  /** Consecutive reconnect attempts; 0 while connected. */
  getReconnectAttemptStore(): Store<number> {
    return this._reconnectAttempt
  }

  /** HTTP verdict about the gateway, probed after repeated socket failures. */
  getConnectionDiagnosisStore(): Store<ConnectionDiagnosis | undefined> {
    return this._connectionDiagnosis
  }

  /** Whether the PC marks this device trusted for high-risk operations. */
  getDeviceTrustedStore(): Store<boolean> {
    return this._deviceTrusted
  }

  /** PC entry script differs from the one this page loaded; reload to update. */
  getWebBuildMismatchStore(): Store<WebBuildMismatch | undefined> {
    return this._webBuildMismatch
  }

  /** Skip the reconnect backoff; the diagnostic card's primary action. */
  retryConnection(): void {
    this._socket.retryNow()
  }

  /** Re-probe `/api/health` now, ignoring the throttle. */
  retryDiagnosis(): void {
    void this._diagnose(true)
  }

  /** VAPID public key from `hello_ok`; undefined when the gateway has no push. */
  getVapidPublicKey(): string | undefined {
    return this._vapidPublicKey
  }

  dismissNotification(): void {
    this._notification.setState(undefined)
  }

  /** PC clock (`hello_ok.serverTime` corrected) so countdown deadlines line up. */
  serverNow(): number {
    return Date.now() + this._serverTimeOffsetMs
  }

  getServerTimeOffsetMs(): number {
    return this._serverTimeOffsetMs
  }

  start(): void {
    this._socket.start()
  }

  subscribePush(subscription: MobilePushSubscription, prefs?: MobileNotificationPrefs): void {
    this._pushSubscription = subscription
    if (prefs !== undefined) this._notificationPrefs = prefs
    this._send({
      type: 'push_subscribe',
      subscription,
      ...(prefs !== undefined ? { prefs } : {}),
    })
  }

  unsubscribePush(): void {
    this._pushSubscription = undefined
    this._send({ type: 'push_unsubscribe' })
  }

  setNotificationPrefs(
    enabled: boolean,
    kinds: readonly MobileAttentionKind[] | undefined,
    alwaysNotify: boolean,
  ): void {
    this._notificationPrefs = {
      enabled,
      ...(kinds !== undefined ? { kinds } : {}),
      alwaysNotify,
    }
    this._send({
      type: 'set_notification_prefs',
      enabled,
      ...(kinds !== undefined ? { kinds } : {}),
      alwaysNotify,
    })
  }

  stop(): void {
    this._socket.stop()
    this._commands.clear()
    this._detail.clear()
    this._webBuildMismatch.setState(undefined)
  }

  /** Subscribe to one session (at most one at a time) and reset its projection. */
  openSession(routeKey: string): void {
    if (this._routeKey === routeKey && !this._session.getState().removed) {
      this._subscribeCurrentSession()
      return
    }
    this._routeKey = routeKey
    this._invalidFrame.setState(undefined)
    this._session.reset()
    this._detail.clear()
    this._currentRef = this._resolveRouteKey(routeKey)
    if (this._currentRef !== undefined) {
      this._subscribeCurrentSession()
      return
    }
    this._maybeResolveRoute()
  }

  /**
   * Open a session named by a command result. The inbox may not contain the
   * new row yet (fork / side task), so subscribe directly instead of waiting
   * for `_maybeResolveRoute`.
   */
  openSessionRef(ref: MobileSessionRef): void {
    const routeKey = sessionRouteKey(ref)
    if (this._routeKey === routeKey && !this._session.getState().removed) {
      this._subscribeCurrentSession()
      return
    }
    this._routeKey = routeKey
    this._invalidFrame.setState(undefined)
    this._session.reset()
    this._detail.clear()
    this._currentRef = ref
    this._subscribeCurrentSession()
  }

  /** Stop mirroring the open session; the PC session keeps running. */
  unsubscribeSession(): void {
    const ref = this._currentRef
    if (ref !== undefined) {
      this._send({ type: 'unsubscribe_session', ref })
    }
    this._routeKey = undefined
    this._currentRef = undefined
    this._invalidFrame.setState(undefined)
    this._session.reset()
    this._detail.clear()
  }

  /** Re-pull the open session's snapshot (fallback after an unacknowledged approval). */
  refreshSession(): void {
    this._invalidFrame.setState(undefined)
    if (this._currentRef === undefined) {
      // A durable-id route keeps `_currentRef` unresolved until the inbox
      // snapshot names it; re-ask for that snapshot instead of doing nothing.
      this._resubscribeInbox()
      return
    }
    this._subscribeCurrentSession()
  }

  requestToolCallDetail(toolCallId: string): Promise<MobileToolCallDetail> {
    const ref = this._currentRef
    if (ref === undefined) {
      return Promise.reject(
        new CommandError('session_not_found', 'no session is open on the phone'),
      )
    }
    return this._detail.request(ref, toolCallId)
  }

  sendPrompt(
    text: string,
    attachmentIds?: readonly string[],
    draftImageIds?: readonly string[],
    draftFileIds?: readonly string[],
  ): Promise<void> {
    return this._sessionCommand('sendPrompt', (ref) => ({
      ref,
      text,
      ...(attachmentIds !== undefined && attachmentIds.length > 0 ? { attachmentIds } : {}),
      ...(draftImageIds !== undefined && draftImageIds.length > 0 ? { draftImageIds } : {}),
      ...(draftFileIds !== undefined && draftFileIds.length > 0 ? { draftFileIds } : {}),
    }))
  }

  /**
   * Publish the composer draft to the gateway. Deliberately bypasses
   * {@link CommandClient}: this is high-frequency and lossy, so there is no
   * request/response, timeout or idempotency cache. Offline edits stay local.
   */
  sendDraft(
    text: string,
    caret: number,
    baseRevision: number,
    images: readonly MobileDraftImageRef[] = [],
    files: readonly MobileDraftFileRef[] = [],
  ): void {
    const ref = this._currentRef
    if (ref === undefined || this._socket.state !== 'connected') return
    this._socket.send({
      type: 'draft_update',
      ref,
      baseRevision,
      clientUpdateId: createCommandId(),
      draft: {
        text,
        caret,
        images,
        ...(files.length > 0 ? { files } : {}),
      },
    })
  }

  uploadAttachment(file: File, kind: MobileAttachmentKind): Promise<MobileAttachmentUploadResult> {
    return this._attachments.upload(file, kind)
  }

  fetchAttachmentBlob(attachmentId: string): Promise<Blob> {
    return this._attachments.fetchBlob({ id: attachmentId })
  }

  fetchMessageImageBlob(messageId: string, index: number): Promise<Blob> {
    const ref = this._currentRef
    if (ref === undefined) {
      return Promise.reject(
        new CommandError('session_not_found', 'no session is open on the phone'),
      )
    }
    return this._attachments.fetchSessionImage(ref, messageId, index)
  }

  fetchWorkspaceImageBlob(src: string): Promise<Blob> {
    const ref = this._currentRef
    if (ref === undefined) {
      return Promise.reject(
        new CommandError('session_not_found', 'no session is open on the phone'),
      )
    }
    return this._attachments.fetchWorkspaceImage(ref, src)
  }

  fetchDraftImageBlob(imageId: string): Promise<Blob> {
    const ref = this._currentRef
    if (ref === undefined) {
      return Promise.reject(
        new CommandError('session_not_found', 'no session is open on the phone'),
      )
    }
    return this._attachments.fetchDraftImage(ref, imageId)
  }

  cancelTurn(): Promise<void> {
    return this._sessionCommand('cancelTurn', (ref) => ({ ref }))
  }

  resolvePermission(requestId: string, optionId: string, feedback?: string): Promise<void> {
    return this._sessionCommand(
      'resolvePermission',
      (ref) => ({
        ref,
        requestId,
        optionId,
        ...(feedback !== undefined && feedback !== '' ? { feedback } : {}),
      }),
      { treatStaleAsSuccess: true },
    )
  }

  cancelPermission(requestId: string): Promise<void> {
    return this._sessionCommand('cancelPermission', (ref) => ({ ref, requestId }), {
      treatStaleAsSuccess: true,
    })
  }

  resolveElicitation(
    requestId: string,
    action: MobileElicitationAction,
    content?: Record<string, MobileElicitationContentValue>,
  ): Promise<void> {
    return this._sessionCommand(
      'resolveElicitation',
      (ref) => ({ ref, requestId, action, ...(content !== undefined ? { content } : {}) }),
      { treatStaleAsSuccess: true },
    )
  }

  setConfigOption(configId: string, value: string | boolean): Promise<void> {
    return this._sessionCommand('setConfigOption', (ref) => ({ ref, configId, value }))
  }

  pauseAutoResolve(requestId: string): Promise<void> {
    return this._sessionCommand('pauseAutoResolve', (ref) => ({ ref, requestId }), {
      treatStaleAsSuccess: true,
    })
  }

  resumeAutoResolve(requestId: string): Promise<void> {
    return this._sessionCommand('resumeAutoResolve', (ref) => ({ ref, requestId }), {
      treatStaleAsSuccess: true,
    })
  }

  renameSession(title: string): Promise<void> {
    return this._sessionCommand('renameSession', (ref) => ({ ref, title }))
  }

  /** End the live PC session but keep its history (`ref` defaults to the open session). */
  closeSession(ref?: MobileSessionRef): Promise<void> {
    const target = ref ?? this._currentRef
    return this._sessionCommandFor('closeSession', target, (resolved) => ({ ref: resolved })).then(
      () => {
        if (target !== undefined) this._inbox.remove(target)
      },
      (error: unknown) => {
        // A close racing with the PC (or a repeated tap) already achieved the
        // user's intent; the row must still disappear.
        if (error instanceof CommandError && error.code === 'session_not_found') {
          if (target !== undefined) this._inbox.remove(target)
          return
        }
        throw error
      },
    )
  }

  /** Delete the session and its history (`ref` defaults to the open session). */
  deleteSession(ref?: MobileSessionRef): Promise<void> {
    const target = ref ?? this._currentRef
    return this._sessionCommandFor('deleteSession', target, (resolved) => ({ ref: resolved })).then(
      () => {
        if (target !== undefined) this._inbox.remove(target)
      },
    )
  }

  forkSession(messageId?: string): Promise<MobileSessionRefResult> {
    return this._sessionCommandValue(
      'forkSession',
      (ref) => ({ ref, ...(messageId !== undefined ? { messageId } : {}) }),
      isMobileSessionRefResult,
    )
  }

  previewRewind(messageId: string): Promise<MobileRewindPreview> {
    return this._sessionCommandValue(
      'previewRewind',
      (ref) => ({ ref, messageId }),
      isMobileRewindPreview,
    )
  }

  rewindSession(messageId: string, rewindFiles?: boolean): Promise<MobileRewindResult> {
    return this._sessionCommandValue(
      'rewindSession',
      (ref) => ({
        ref,
        messageId,
        ...(rewindFiles !== undefined ? { rewindFiles } : {}),
      }),
      isMobileRewindResult,
    )
  }

  createSideTask(quote?: string): Promise<MobileSessionRefResult> {
    return this._sessionCommandValue(
      'createSideTask',
      (ref) => ({ ref, ...(quote !== undefined && quote !== '' ? { quote } : {}) }),
      isMobileSessionRefResult,
    )
  }

  listSideTasks(): Promise<readonly MobileSideTaskSummary[]> {
    return this._sessionCommandValue('listSideTasks', (ref) => ({ ref }), isMobileSideTaskList)
  }

  openSideTask(sideTaskId: string): Promise<MobileSessionRefResult> {
    return this._sessionCommandValue(
      'openSideTask',
      (ref) => ({ ref, sideTaskId }),
      isMobileSessionRefResult,
    )
  }

  deleteSideTask(sideTaskId: string): Promise<void> {
    return this._sessionCommand('deleteSideTask', (ref) => ({ ref, sideTaskId }))
  }

  /** Inspect the repository behind an inbox row without opening the session. */
  previewDelivery(ref: MobileSessionRef): Promise<MobileDeliveryPreview> {
    return this._commandValueFor('previewDelivery', ref, isMobileDeliveryPreview)
  }

  startDelivery(
    ref: MobileSessionRef,
    expectation: MobileDeliveryExpectation,
  ): Promise<MobileDeliveryStartResult> {
    return this._commandValueFor('startDelivery', ref, isMobileDeliveryStartResult, (target) => ({
      ref: target,
      expectation,
    }))
  }

  getDelivery(ref: MobileSessionRef, deliveryId: string): Promise<MobileDeliveryDetail> {
    return this._commandValueFor('getDelivery', ref, isMobileDeliveryDetail, (target) => ({
      ref: target,
      deliveryId,
    }))
  }

  confirmDeliveryPush(ref: MobileSessionRef, deliveryId: string): Promise<void> {
    return this._commandFor('confirmDeliveryPush', ref, (target) => ({ ref: target, deliveryId }))
  }

  retryDelivery(ref: MobileSessionRef, deliveryId: string): Promise<void> {
    return this._commandFor('retryDelivery', ref, (target) => ({ ref: target, deliveryId }))
  }

  undoDelivery(ref: MobileSessionRef, deliveryId: string): Promise<void> {
    return this._commandFor('undoDelivery', ref, (target) => ({ ref: target, deliveryId }))
  }

  openDeliveryMainWorktree(ref: MobileSessionRef, deliveryId: string): Promise<void> {
    return this._commandFor('openDeliveryMainWorktree', ref, (target) => ({
      ref: target,
      deliveryId,
    }))
  }

  /** Inspect the session branch and its remote without writing anything. */
  previewPushBranch(ref: MobileSessionRef): Promise<MobilePushBranchPreview> {
    return this._commandValueFor('previewPushBranch', ref, isMobilePushBranchPreview)
  }

  /** Publish the session branch, pinning the heads returned by the preview. */
  pushBranch(
    ref: MobileSessionRef,
    expectation: MobilePushBranchExpectation,
  ): Promise<MobilePushBranchResult> {
    return this._commandValueFor('pushBranch', ref, isMobilePushBranchResult, (target) => ({
      ref: target,
      expectation,
    }))
  }

  async newSession(
    agentId: string,
    workspace: { folder: string; authority?: string },
    initialPrompt?: string,
  ): Promise<MobileNewSessionResult> {
    return this._commands.request<MobileNewSessionResult>('newSession', {
      agentId,
      workspace,
      ...(initialPrompt !== undefined && initialPrompt !== '' ? { initialPrompt } : {}),
    })
  }

  async listAgents(): Promise<readonly MobileAgentCandidate[]> {
    return this._commands.request<readonly MobileAgentCandidate[]>(
      'listAgents',
      {},
      {
        validateResult: (value) => Array.isArray(value),
      },
    )
  }

  async listWorkspaces(): Promise<readonly MobileWorkspaceCandidate[]> {
    return this._commands.request<readonly MobileWorkspaceCandidate[]>(
      'listWorkspaces',
      {},
      {
        validateResult: (value) => Array.isArray(value),
      },
    )
  }

  /** Resumable history rows from every open PC window. */
  async listSessionHistory(): Promise<readonly MobileSessionHistoryEntry[]> {
    return this._commands.request<readonly MobileSessionHistoryEntry[]>(
      'listSessionHistory',
      {},
      { validateResult: isMobileSessionHistoryList },
    )
  }

  /**
   * Resume a history-only session without activating it on the PC. A closed
   * workspace's row supplies `folder` (+ remote `authority`) so the gateway can
   * open the workspace before resuming.
   */
  async resumeSession(
    durableId: string,
    windowId?: number,
    folder?: string,
    authority?: string,
  ): Promise<MobileSessionRefResult> {
    return this._commands.request<MobileSessionRefResult>(
      'openSession',
      {
        durableId,
        ...(windowId !== undefined ? { windowId } : {}),
        ...(folder !== undefined ? { folder } : {}),
        ...(authority !== undefined ? { authority } : {}),
      },
      { validateResult: isMobileSessionRefResult },
    )
  }

  private _sessionCommand(
    kind: MobileCommandKind,
    payloadFor: (ref: MobileSessionRef) => unknown,
    options?: CommandRequestOptions,
  ): Promise<void> {
    return this._sessionCommandFor(kind, undefined, payloadFor, options)
  }

  private _sessionCommandFor(
    kind: MobileCommandKind,
    explicitRef: MobileSessionRef | undefined,
    payloadFor: (ref: MobileSessionRef) => unknown,
    options?: CommandRequestOptions,
  ): Promise<void> {
    const ref = explicitRef ?? this._currentRef
    if (ref === undefined) {
      return Promise.reject(
        new CommandError('session_not_found', 'no session is open on the phone'),
      )
    }
    return this._commands.request<void>(kind, payloadFor(ref), options)
  }

  private _sessionCommandValue<T>(
    kind: MobileCommandKind,
    payloadFor: (ref: MobileSessionRef) => unknown,
    validateResult: (value: unknown) => boolean,
  ): Promise<T> {
    const ref = this._currentRef
    if (ref === undefined) {
      return Promise.reject(
        new CommandError('session_not_found', 'no session is open on the phone'),
      )
    }
    return this._commands.request<T>(kind, payloadFor(ref), { validateResult })
  }

  /** Commands addressed by an explicit inbox row rather than the open session. */
  private _commandValueFor<T>(
    kind: MobileCommandKind,
    ref: MobileSessionRef,
    validateResult: (value: unknown) => boolean,
    payloadFor: (ref: MobileSessionRef) => unknown = (target) => ({ ref: target }),
  ): Promise<T> {
    return this._commands.request<T>(kind, payloadFor(ref), { validateResult })
  }

  private _commandFor(
    kind: MobileCommandKind,
    ref: MobileSessionRef,
    payloadFor: (ref: MobileSessionRef) => unknown,
  ): Promise<void> {
    return this._commands.request<void>(kind, payloadFor(ref))
  }

  private _handleState(state: SocketState): void {
    this._socketState.setState(state)
    if (state === 'connected') {
      this._connectionEpoch += 1
      this._connectionDiagnosis.setState(undefined)
      // Reconnect: commands whose response was lost are retried verbatim; the
      // gateway answers mutating duplicates from its idempotency cache.
      this._commands.resendPending()
      this._subscribeCurrentSession()
      // Re-register a push subscription the server may have lost with the socket.
      if (this._pushSubscription !== undefined) {
        this._send({
          type: 'push_subscribe',
          subscription: this._pushSubscription,
          ...(this._notificationPrefs !== undefined ? { prefs: this._notificationPrefs } : {}),
        })
      }
    } else if (state === 'invalid' || state === 'protocol_mismatch') {
      this._connectionEpoch += 1
      this._connectionDiagnosis.setState(undefined)
    }
  }

  private _handleReconnectAttempt(attempt: number): void {
    this._reconnectAttempt.setState(attempt)
    if (attempt === 0) {
      this._connectionDiagnosis.setState(undefined)
      return
    }
    if (attempt < DIAGNOSE_AFTER_ATTEMPTS) return
    const now = this._timers?.now() ?? Date.now()
    if (now - this._lastDiagnosisAt < DIAGNOSIS_MIN_INTERVAL_MS) return
    void this._diagnose()
  }

  private async _diagnose(force = false): Promise<void> {
    if (this._diagnosisInFlight) return
    const now = this._timers?.now() ?? Date.now()
    if (!force && now - this._lastDiagnosisAt < DIAGNOSIS_MIN_INTERVAL_MS) return
    this._diagnosisInFlight = true
    this._lastDiagnosisAt = now
    const epoch = this._connectionEpoch
    try {
      const diagnosis = await probeGatewayHealth(this._origin, {
        fetchImpl: this._fetchImpl,
      })
      // A reconnect may have completed while the probe was in flight; showing
      // its result then would contradict the connected UI.
      if (epoch !== this._connectionEpoch) return
      this._connectionDiagnosis.setState(diagnosis)
    } finally {
      this._diagnosisInFlight = false
    }
  }

  private _handleFrame(frame: ServerFrame): void {
    switch (frame.type) {
      case 'inbox_snapshot':
        this._afterInbox(this._inbox.applySnapshot(frame))
        break
      case 'inbox_delta':
        this._afterInbox(this._inbox.applyDelta(frame))
        break
      case 'session_snapshot':
        this._applySessionSnapshot(frame.session.summary.ref, frame)
        break
      case 'session_delta': {
        if (this._currentRef === undefined || !refMatches(this._currentRef, frame.ref)) break
        const result = this._session.applyDelta(frame, this._logger)
        if (result.status === 'resubscribe') {
          this._subscribeCurrentSession()
        } else if (result.status === 'applied') {
          const state = this._session.getState()
          if (state.ref !== undefined) this._currentRef = state.ref
          for (const event of frame.events) {
            if (event.type === 'tool_call_upsert') this._detail.invalidate(event.item.id)
          }
        }
        break
      }
      case 'session_removed':
        if (this._currentRef !== undefined && refMatches(this._currentRef, frame.ref)) {
          // The removal can arrive before the first snapshot (the PC closed the
          // session while the phone was still loading it); mark it anyway so the
          // page shows "closed on PC" instead of timing out on a snapshot.
          if (!this._session.applyRemoved(frame.ref)) this._session.markRemoved()
        }
        break
      case 'notification':
        // The session page already surfaces a pending card or the reply; only
        // toast when the user is looking at something else.
        if (this._currentRef === undefined || !refMatches(this._currentRef, frame.ref)) {
          this._notification.setState(frame)
        }
        break
      case 'command_result':
        this._commands.handleResult(frame)
        break
      case 'resync_required':
        if (frame.scope === 'inbox') {
          this._resubscribeInbox()
        } else if (
          this._currentRef !== undefined &&
          (frame.ref === undefined || refMatches(this._currentRef, frame.ref))
        ) {
          this._subscribeCurrentSession()
        }
        break
      case 'server_error':
        this._logger.warn(`mobile gateway error: ${frame.code} ${frame.message}`)
        break
      case 'device_revoked':
        break
    }
  }

  private _applySessionSnapshot(ref: MobileSessionRef, frame: SessionSnapshotFrame): void {
    if (this._currentRef !== undefined && !refMatches(this._currentRef, ref)) return
    this._currentRef = ref
    this._session.applySnapshot(frame)
    this._invalidFrame.setState(undefined)
    const state = this._session.getState()
    if (state.ref !== undefined) this._currentRef = state.ref
  }

  private _afterInbox(result: InboxApplyResult): void {
    if (result.status === 'resubscribe') {
      this._resubscribeInbox()
      return
    }
    this._maybeResolveRoute()
  }

  private _resubscribeInbox(): void {
    this._send({ type: 'subscribe_inbox' })
  }

  private _subscribeCurrentSession(): void {
    if (this._currentRef === undefined) return
    this._send({ type: 'subscribe_session', ref: this._currentRef })
  }

  private _send(frame: ClientFrame): void {
    this._socket.send(frame)
  }

  /**
   * Commands are only sent while the gateway handshake is complete. A closed
   * socket rejects up front (`network`) instead of leaving the caller waiting
   * the full timeout for a frame that was silently dropped.
   */
  private _sendCommand(frame: CommandFrame): void {
    if (this._socket.state !== 'connected') {
      throw new CommandError('network', 'mobile gateway is not connected')
    }
    this._socket.send(frame)
  }

  private _resolveRouteKey(key: string): MobileSessionRef | undefined {
    for (const session of this._inbox.getState().sessions) {
      if (session.ref.durableId === key) return session.ref
    }
    return parseSessionRouteKey(key)
  }

  /**
   * Route keys that carry a durable id can only be resolved once the inbox
   * snapshot is in. Retry from every inbox frame; a snapshot without a match
   * means the PC closed the session.
   */
  private _maybeResolveRoute(): void {
    if (this._routeKey === undefined || this._currentRef !== undefined) return
    const resolved = this._resolveRouteKey(this._routeKey)
    if (resolved !== undefined) {
      this._currentRef = resolved
      this._subscribeCurrentSession()
      return
    }
    if (this._inbox.getState().hasSnapshot) this._session.markRemoved()
  }

  /** Route key of the open session (used by tests and navigation). */
  getOpenRouteKey(): string | undefined {
    return this._currentRef === undefined ? undefined : sessionRouteKey(this._currentRef)
  }
}
