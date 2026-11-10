import {
  MOBILE_CLOSE_CODES,
  MOBILE_PROTOCOL_VERSION,
  parseServerFrame,
  serializeFrame,
  type ClientFrame,
  type ParseError,
  type ServerFrame,
} from '@universe-editor/mobile-protocol'

export type SocketState =
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'invalid'
  | 'protocol_mismatch'

export const MOBILE_CLIENT_VERSION = '0.0.0-m4'

export const RECONNECT_BASE_MS = 1_000
export const RECONNECT_MAX_MS = 30_000
export const HEARTBEAT_INTERVAL_MS = 20_000
export const HEARTBEAT_TIMEOUT_MS = 45_000

const RECONNECT_JITTER_MIN = 0.8
const RECONNECT_JITTER_MAX = 1.2
const OPEN_READY_STATE = 1

/** Minimal surface the client needs from a WebSocket implementation. */
export interface WebSocketLike {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: (() => void) | null
  onmessage: ((event: { readonly data: unknown }) => void) | null
  onclose: ((event: { readonly code: number; readonly reason: string }) => void) | null
  onerror: ((event: unknown) => void) | null
}

export type TimerHandle = unknown

export interface TimerApi {
  setTimeout(callback: () => void, delayMs: number): TimerHandle
  clearTimeout(handle: TimerHandle): void
  setInterval(callback: () => void, intervalMs: number): TimerHandle
  clearInterval(handle: TimerHandle): void
  now(): number
}

export interface MobileSocketOptions {
  readonly url: string
  readonly token: string
  readonly createWebSocket: (url: string) => WebSocketLike
  readonly clientVersion?: string | undefined
  readonly timers?: TimerApi | undefined
  readonly random?: (() => number) | undefined
  readonly onStateChange?: ((state: SocketState) => void) | undefined
  readonly onFrame?: ((frame: ServerFrame) => void) | undefined
  /** A frame the protocol validator rejected; the caller may surface it to the UI. */
  readonly onInvalidFrame?: ((error: ParseError) => void) | undefined
  /** Server clock from `hello_ok`; the phone corrects countdown deadlines with it. */
  readonly onServerTime?: ((serverTime: number) => void) | undefined
  /** VAPID public key advertised by the gateway, when Web Push is available. */
  readonly onVapidPublicKey?: ((key: string | undefined) => void) | undefined
  /** Whether the PC allows high-risk operations from this device. */
  readonly onDeviceTrust?: ((trusted: boolean) => void) | undefined
  /** Foreground/background transitions, mirrored to the gateway as `client_state`. */
  readonly onVisibilityChange?: ((visible: boolean) => void) | undefined
  /** Revoked / unauthorized credentials: the caller must clear local state. */
  readonly onCredentialsInvalid?: (() => void) | undefined
  readonly onProtocolMismatch?: (() => void) | undefined
  /** Consecutive reconnect attempts; resets to 0 once `hello_ok` lands. */
  readonly onReconnectAttempt?: ((attempt: number) => void) | undefined
  readonly logger?: Pick<Console, 'warn'> | undefined
}

const defaultTimers: TimerApi = {
  setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (callback, intervalMs) => globalThis.setInterval(callback, intervalMs),
  clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
  now: () => Date.now(),
}

/**
 * WebSocket client for the phone gateway: token in the first `hello` frame,
 * application-level heartbeats (Tailscale Serve can drop idle sockets without a
 * close frame), and jittered exponential reconnect. Terminal close codes stop
 * the loop and ask the caller to clear credentials.
 */
export class MobileSocket {
  private readonly _url: string
  private readonly _token: string
  private readonly _createWebSocket: (url: string) => WebSocketLike
  private readonly _clientVersion: string
  private readonly _timers: TimerApi
  private readonly _random: () => number
  private readonly _logger: Pick<Console, 'warn'>
  private readonly _onStateChange: ((state: SocketState) => void) | undefined
  private readonly _onFrame: ((frame: ServerFrame) => void) | undefined
  private readonly _onInvalidFrame: ((error: ParseError) => void) | undefined
  private readonly _onServerTime: ((serverTime: number) => void) | undefined
  private readonly _onVapidPublicKey: ((key: string | undefined) => void) | undefined
  private readonly _onDeviceTrust: ((trusted: boolean) => void) | undefined
  private readonly _onVisibilityChange: ((visible: boolean) => void) | undefined
  private readonly _onCredentialsInvalid: (() => void) | undefined
  private readonly _onProtocolMismatch: (() => void) | undefined
  private readonly _onReconnectAttempt: ((attempt: number) => void) | undefined

  private _socket: WebSocketLike | undefined
  private _state: SocketState = 'connecting'
  private _stopped = true
  private _reconnectTimer: TimerHandle
  private _heartbeatTimer: TimerHandle
  private _pongDeadline: TimerHandle
  private _reconnectAttempt = 0
  private _lastPongAt = 0

  private readonly _handleVisibilityChange = (): void => {
    if (typeof document === 'undefined') return
    const visible = document.visibilityState === 'visible'
    this._onVisibilityChange?.(visible)
    this._sendClientState(visible)
    if (visible) this._retryNow()
  }

  private readonly _onOnline = (): void => {
    this._retryNow()
  }

  constructor(options: MobileSocketOptions) {
    this._url = options.url
    this._token = options.token
    this._createWebSocket = options.createWebSocket
    this._clientVersion = options.clientVersion ?? MOBILE_CLIENT_VERSION
    this._timers = options.timers ?? defaultTimers
    this._random = options.random ?? Math.random
    this._logger = options.logger ?? console
    this._onStateChange = options.onStateChange
    this._onFrame = options.onFrame
    this._onInvalidFrame = options.onInvalidFrame
    this._onServerTime = options.onServerTime
    this._onVapidPublicKey = options.onVapidPublicKey
    this._onDeviceTrust = options.onDeviceTrust
    this._onVisibilityChange = options.onVisibilityChange
    this._onCredentialsInvalid = options.onCredentialsInvalid
    this._onProtocolMismatch = options.onProtocolMismatch
    this._onReconnectAttempt = options.onReconnectAttempt
  }

  get state(): SocketState {
    return this._state
  }

  get reconnectAttempt(): number {
    return this._reconnectAttempt
  }

  start(): void {
    if (!this._stopped) return
    this._stopped = false
    this._attachGlobalListeners()
    this._connect()
  }

  /** Queue a client frame; ignored while the socket is not open. */
  send(frame: ClientFrame): void {
    this._send(frame)
  }

  stop(): void {
    if (this._stopped) return
    this._stopped = true
    this._detachGlobalListeners()
    this._clearReconnectTimer()
    this._stopHeartbeat()
    this._terminateSocket(1000, 'client stopped')
  }

  /** Skip the current backoff and redial; used by the connection diagnostic UI. */
  retryNow(): void {
    this._retryNow()
  }

  private _connect(): void {
    if (this._stopped) return
    this._clearReconnectTimer()
    if (this._state !== 'reconnecting') this._setState('connecting')

    let socket: WebSocketLike
    try {
      socket = this._createWebSocket(this._url)
    } catch (error) {
      this._logger.warn('mobile socket: failed to create WebSocket', error)
      this._scheduleReconnect()
      return
    }
    this._socket = socket

    socket.onopen = () => {
      if (this._socket !== socket) return
      this._sendHello()
    }
    socket.onmessage = (event) => {
      if (this._socket !== socket) return
      this._handleMessage(event.data)
    }
    socket.onclose = (event) => {
      if (this._socket !== socket) return
      this._socket = undefined
      this._handleClose(event.code)
    }
    socket.onerror = () => {
      // Browsers fire `close` after `error`; let that path schedule the retry so
      // one failed connection never arms two timers.
    }
  }

  private _sendHello(): void {
    this._send({
      type: 'hello',
      protocolVersion: MOBILE_PROTOCOL_VERSION,
      token: this._token,
      clientVersion: this._clientVersion,
      capabilities: ['inbox', 'session', 'notifications'],
    })
  }

  private _handleMessage(data: unknown): void {
    if (typeof data !== 'string') {
      this._logger.warn('mobile socket: ignored non-text frame')
      this._onInvalidFrame?.({ code: 'bad_request', message: 'frame is not text' })
      return
    }
    const parsed = parseServerFrame(data)
    if (!parsed.ok) {
      this._logger.warn(`mobile socket: ignored invalid frame (${parsed.error.message})`)
      this._onInvalidFrame?.(parsed.error)
      return
    }
    const frame = parsed.value
    switch (frame.type) {
      case 'hello_ok':
        this._onServerTime?.(frame.serverTime)
        this._onVapidPublicKey?.(frame.vapidPublicKey)
        this._onDeviceTrust?.(frame.trusted)
        this._handleHelloOk()
        break
      case 'device_trust_changed':
        this._onDeviceTrust?.(frame.trusted)
        break
      case 'pong':
        this._notePong()
        break
      case 'device_revoked':
        this._handleRevoked()
        this._onFrame?.(frame)
        break
      case 'inbox_snapshot':
      case 'inbox_delta':
      case 'session_snapshot':
      case 'session_delta':
      case 'session_removed':
      case 'command_result':
      case 'notification':
      case 'resync_required':
      case 'server_error':
        this._onFrame?.(frame)
        break
    }
  }

  private _handleHelloOk(): void {
    this._reconnectAttempt = 0
    this._onReconnectAttempt?.(0)
    this._startHeartbeat()
    this._setState('connected')
    this._sendClientState(typeof document === 'undefined' || document.visibilityState === 'visible')
    this._send({ type: 'subscribe_inbox' })
  }

  private _sendClientState(visible: boolean): void {
    this._send({ type: 'client_state', visible })
  }

  private _handleRevoked(): void {
    this._clearReconnectTimer()
    this._stopHeartbeat()
    this._terminateSocket(MOBILE_CLOSE_CODES.REVOKED, 'device revoked')
    this._setState('invalid')
    this._onCredentialsInvalid?.()
  }

  private _handleClose(code: number): void {
    this._stopHeartbeat()
    if (code === MOBILE_CLOSE_CODES.UNAUTHORIZED || code === MOBILE_CLOSE_CODES.REVOKED) {
      this._clearReconnectTimer()
      this._setState('invalid')
      this._onCredentialsInvalid?.()
      return
    }
    if (code === MOBILE_CLOSE_CODES.PROTOCOL_MISMATCH) {
      this._clearReconnectTimer()
      this._setState('protocol_mismatch')
      this._onProtocolMismatch?.()
      return
    }
    this._scheduleReconnect()
  }

  private _scheduleReconnect(): void {
    if (this._stopped) return
    this._setState('reconnecting')
    if (this._reconnectTimer !== undefined) return

    const base = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this._reconnectAttempt)
    const jitter =
      RECONNECT_JITTER_MIN + this._random() * (RECONNECT_JITTER_MAX - RECONNECT_JITTER_MIN)
    const delay = Math.min(RECONNECT_MAX_MS, Math.round(base * jitter))
    this._reconnectAttempt += 1
    this._onReconnectAttempt?.(this._reconnectAttempt)
    this._reconnectTimer = this._timers.setTimeout(() => {
      this._reconnectTimer = undefined
      this._connect()
    }, delay)
  }

  private _retryNow(): void {
    if (this._stopped) return
    if (this._state === 'invalid' || this._state === 'protocol_mismatch') return
    if (this._state === 'connected') return
    this._clearReconnectTimer()
    this._terminateSocket(1000, 'immediate retry')
    this._connect()
  }

  private _startHeartbeat(): void {
    this._stopHeartbeat()
    this._notePong()
    this._heartbeatTimer = this._timers.setInterval(
      () => this._heartbeatTick(),
      HEARTBEAT_INTERVAL_MS,
    )
  }

  private _heartbeatTick(): void {
    if (this._state !== 'connected') return
    if (this._timers.now() - this._lastPongAt > HEARTBEAT_TIMEOUT_MS) {
      this._heartbeatTimeout()
      return
    }
    this._send({ type: 'ping', t: this._timers.now() })
  }

  private _notePong(): void {
    this._lastPongAt = this._timers.now()
    if (this._pongDeadline !== undefined) this._timers.clearTimeout(this._pongDeadline)
    this._pongDeadline = this._timers.setTimeout(
      () => this._heartbeatTimeout(),
      HEARTBEAT_TIMEOUT_MS,
    )
  }

  private _heartbeatTimeout(): void {
    if (this._state !== 'connected') return
    this._stopHeartbeat()
    this._terminateSocket(1000, 'heartbeat timeout')
    this._scheduleReconnect()
  }

  private _stopHeartbeat(): void {
    if (this._heartbeatTimer !== undefined) {
      this._timers.clearInterval(this._heartbeatTimer)
      this._heartbeatTimer = undefined
    }
    if (this._pongDeadline !== undefined) {
      this._timers.clearTimeout(this._pongDeadline)
      this._pongDeadline = undefined
    }
  }

  private _clearReconnectTimer(): void {
    if (this._reconnectTimer === undefined) return
    this._timers.clearTimeout(this._reconnectTimer)
    this._reconnectTimer = undefined
  }

  private _terminateSocket(code: number, reason: string): void {
    const socket = this._socket
    this._socket = undefined
    if (socket === undefined) return
    socket.onopen = null
    socket.onmessage = null
    socket.onclose = null
    socket.onerror = null
    try {
      socket.close(code, reason)
    } catch {
      // Already closed by the transport.
    }
  }

  private _send(frame: ClientFrame): void {
    const socket = this._socket
    if (socket === undefined || socket.readyState !== OPEN_READY_STATE) return
    try {
      socket.send(serializeFrame(frame))
    } catch (error) {
      this._logger.warn('mobile socket: send failed', error)
    }
  }

  private _setState(state: SocketState): void {
    if (this._state === state) return
    this._state = state
    this._onStateChange?.(state)
  }

  private _attachGlobalListeners(): void {
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this._handleVisibilityChange)
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this._onOnline)
    }
  }

  private _detachGlobalListeners(): void {
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this._handleVisibilityChange)
    }
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this._onOnline)
    }
  }
}

/** Same-origin WS URL, built without the token so it never reaches access logs. */
export function websocketUrlForLocation(location: {
  readonly protocol: string
  readonly host: string
}): string {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${scheme}//${location.host}/ws`
}
