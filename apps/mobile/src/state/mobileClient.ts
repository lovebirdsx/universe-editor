import type {
  ClientFrame,
  MobileSessionRef,
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
import { InboxStore, type InboxApplyResult } from './inboxStore.js'
import { parseSessionRouteKey, refMatches, sessionRouteKey } from './refs.js'
import { SessionStore } from './sessionStore.js'
import { Store } from './store.js'
import { ToolCallDetailClient, ToolCallDetailError } from './toolCallDetailClient.js'

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
 */
export class MobileClient {
  private readonly _socket: MobileSocket
  private readonly _socketState = new Store<SocketState>('connecting')
  private readonly _inbox = new InboxStore()
  private readonly _session = new SessionStore()
  private readonly _detail: ToolCallDetailClient
  private readonly _logger: Pick<Console, 'warn'>
  private _currentRef: MobileSessionRef | undefined
  private _routeKey: string | undefined

  constructor(options: MobileClientOptions) {
    this._logger = options.logger ?? console
    this._socket = new MobileSocket({
      url: options.url,
      token: options.credentials.token,
      createWebSocket: options.createWebSocket,
      timers: options.timers,
      random: options.random,
      logger: this._logger,
      onStateChange: (state) => this._handleState(state),
      onFrame: (frame) => this._handleFrame(frame),
      onCredentialsInvalid: () => {
        this._inbox.reset()
        this._session.reset()
        options.onCredentialsInvalid?.()
      },
      onProtocolMismatch: options.onProtocolMismatch,
    })
    this._detail = new ToolCallDetailClient({
      send: (frame) => this._socket.send(frame),
      timers: options.timers,
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

  start(): void {
    this._socket.start()
  }

  stop(): void {
    this._socket.stop()
    this._detail.clear()
  }

  /** Subscribe to one session (at most one at a time) and reset its projection. */
  openSession(routeKey: string): void {
    if (this._routeKey === routeKey && !this._session.getState().removed) {
      this._subscribeCurrentSession()
      return
    }
    this._routeKey = routeKey
    this._session.reset()
    this._detail.clear()
    this._currentRef = this._resolveRouteKey(routeKey)
    if (this._currentRef !== undefined) {
      this._subscribeCurrentSession()
      return
    }
    this._maybeResolveRoute()
  }

  closeSession(): void {
    const ref = this._currentRef
    if (ref !== undefined) {
      this._send({ type: 'unsubscribe_session', ref })
    }
    this._routeKey = undefined
    this._currentRef = undefined
    this._session.reset()
    this._detail.clear()
  }

  requestToolCallDetail(toolCallId: string): ReturnType<ToolCallDetailClient['request']> {
    const ref = this._currentRef
    if (ref === undefined) {
      return Promise.reject(
        new ToolCallDetailError('session_not_found', 'no session is open on the phone'),
      )
    }
    return this._detail.request(ref, toolCallId)
  }

  private _handleState(state: SocketState): void {
    this._socketState.setState(state)
    if (state === 'connected') this._subscribeCurrentSession()
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
          this._session.applyRemoved(frame.ref)
        }
        break
      case 'command_result':
        this._detail.handleResult(frame)
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
