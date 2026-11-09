import type {
  ClientFrame,
  CommandFrame,
  MobileAgentCandidate,
  MobileAttachmentKind,
  MobileAttachmentUploadResult,
  MobileCommandKind,
  MobileAttentionKind,
  MobileElicitationAction,
  MobileElicitationContentValue,
  MobileNewSessionResult,
  MobileNotificationPrefs,
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
import { CommandClient, CommandError, type CommandRequestOptions } from './commandClient.js'
import { AttachmentClient, httpOriginForSocketUrl } from './attachmentClient.js'
import {
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
  readonly onCredentialsInvalid?: (() => void) | undefined
  readonly onProtocolMismatch?: (() => void) | undefined
  readonly logger?: Pick<Console, 'warn'> | undefined
}

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
  private readonly _logger: Pick<Console, 'warn'>
  private _currentRef: MobileSessionRef | undefined
  private _routeKey: string | undefined
  private _serverTimeOffsetMs = 0
  private _vapidPublicKey: string | undefined
  private _pushSubscription: MobilePushSubscription | undefined
  private _notificationPrefs: MobileNotificationPrefs | undefined

  constructor(options: MobileClientOptions) {
    this._logger = options.logger ?? console
    this._commands = new CommandClient({
      send: (frame) => this._sendCommand(frame),
      timers: options.timers,
    })
    this._attachments = new AttachmentClient({
      origin: httpOriginForSocketUrl(options.url),
      token: options.credentials.token,
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
      onCredentialsInvalid: () => {
        this._inbox.reset()
        this._session.reset()
        options.onCredentialsInvalid?.()
      },
      onProtocolMismatch: options.onProtocolMismatch,
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

  sendPrompt(text: string, attachmentIds?: readonly string[]): Promise<void> {
    return this._sessionCommand('sendPrompt', (ref) => ({
      ref,
      text,
      ...(attachmentIds !== undefined && attachmentIds.length > 0 ? { attachmentIds } : {}),
    }))
  }

  uploadAttachment(file: File, kind: MobileAttachmentKind): Promise<MobileAttachmentUploadResult> {
    return this._attachments.upload(file, kind)
  }

  fetchAttachmentBlob(attachmentId: string): Promise<Blob> {
    return this._attachments.fetchBlob({ id: attachmentId })
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

  /** Resume a history-only session without activating it on the PC. */
  async resumeSession(durableId: string, windowId?: number): Promise<MobileSessionRefResult> {
    return this._commands.request<MobileSessionRefResult>(
      'openSession',
      {
        durableId,
        ...(windowId !== undefined ? { windowId } : {}),
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

  private _handleState(state: SocketState): void {
    this._socketState.setState(state)
    if (state === 'connected') {
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
