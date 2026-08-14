/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Client side of an ExtensionHost tunnel: a second TCP connection (same
 *  forwarded port as Management) that degrades to a raw byte pipe after the
 *  handshake. A PersistentProtocol keeps the byte stream gap-free across socket
 *  swaps — unacknowledged sends are re-driven on reconnect, so the extension-host
 *  RPC never sees a drop. A child crash arrives as an in-band `{type:'exit'}`
 *  Control frame; a permanent handshake rejection gives up and fires onDidClose.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  Emitter,
  PersistentProtocol,
  ProtocolConstants,
  RemoteConnectionErrorCode,
  decodeControlJson,
  type Event,
  type ILogger,
  type IRemoteConnectionRequest,
  type ISocket,
} from '@universe-editor/platform'
import { performClientHandshake, type RemoteHandshakeError } from './remoteHandshake.js'

export interface IRemoteExtensionHostTunnel {
  send(data: Uint8Array): void
  readonly onData: Event<Uint8Array>
  readonly onExit: Event<{ code: number | null }>
  readonly onDidClose: Event<void>
  /** Drop the underlying socket (E2E only) to exercise transparent reconnection. */
  dropSocketForTesting(): void
  dispose(): void
}

const RECONNECT_BACKOFF_MS = [250, 500, 1000, 2000, 2000] as const

const PERMANENT_RECONNECT_CODES: ReadonlySet<string> = new Set([
  RemoteConnectionErrorCode.InvalidToken,
  RemoteConnectionErrorCode.VersionMismatch,
  RemoteConnectionErrorCode.UnknownReconnectionToken,
  RemoteConnectionErrorCode.DuplicateReconnectionToken,
])

export interface RemoteExtensionHostTunnelOptions {
  readonly authority: string
  /** Opens a fresh TCP socket to the daemon (forward or direct port). */
  readonly connectSocket: () => Promise<ISocket>
  readonly buildRequest: (
    isReconnection: boolean,
  ) => Omit<IRemoteConnectionRequest, 'type' | 'protocolVersion'>
  readonly logger: ILogger
  readonly label: string
}

export class RemoteExtensionHostTunnel extends Disposable implements IRemoteExtensionHostTunnel {
  readonly authority: string
  private readonly _onData = this._register(new Emitter<Uint8Array>())
  readonly onData = this._onData.event
  private readonly _onExit = this._register(new Emitter<{ code: number | null }>())
  readonly onExit = this._onExit.event
  private readonly _onDidClose = this._register(new Emitter<void>())
  readonly onDidClose = this._onDidClose.event

  private readonly _opts: RemoteExtensionHostTunnelOptions
  private _protocol: PersistentProtocol | null = null
  private _socket: ISocket | null = null
  private _reconnectTimer: NodeJS.Timeout | null = null
  private _reconnectSocket: ISocket | null = null
  private _reconnectAttempt = 0
  private _reconnectionStart = 0
  private _opened = false
  private _closedByUser = false
  private _disposed = false

  constructor(opts: RemoteExtensionHostTunnelOptions) {
    super()
    this.authority = opts.authority
    this._opts = opts
  }

  async open(): Promise<void> {
    if (this._disposed) throw new Error(`${this._opts.label}: disposed`)
    const socket = await this._opts.connectSocket()
    let residual: Uint8Array
    try {
      residual = (await performClientHandshake(socket, this._opts.buildRequest(false))).residual
    } catch (err) {
      socket.dispose()
      throw err
    }
    this._socket = socket
    const protocol = new PersistentProtocol({ socket, initialChunk: residual })
    this._protocol = protocol
    this._register(protocol)
    this._register(protocol.onMessage((data) => this._onData.fire(data)))
    this._register(protocol.onControlMessage((data) => this._handleControl(data)))
    this._register(protocol.onSocketClose(() => this._onSocketDisconnected()))
    this._register(protocol.onSocketTimeout(() => this._onSocketDisconnected()))
    this._register(protocol.onDidClose(() => this._fireClose()))
    this._opened = true
    this._opts.logger.info(`${this._opts.label} connected`)
  }

  send(data: Uint8Array): void {
    this._protocol?.send(data)
  }

  dropSocketForTesting(): void {
    // Disposing the socket does NOT fire onClose (NodeSocket.removeAllListeners
    // runs first), so kick the reconnect path explicitly — same as the management
    // connection's dropSocketForTesting.
    this._protocol?.getSocket().dispose()
    this._onSocketDisconnected()
  }

  private _handleControl(data: Uint8Array): void {
    let msg: unknown
    try {
      msg = decodeControlJson(data)
    } catch {
      return
    }
    if ((msg as { type?: unknown }).type !== 'exit') return
    const code = (msg as { code?: unknown }).code
    this._onExit.fire({ code: typeof code === 'number' ? code : null })
  }

  private _onSocketDisconnected(): void {
    if (!this._opened || this._closedByUser || this._disposed) return
    if (this._reconnectTimer) return
    this._reconnectAttempt = 0
    this._reconnectionStart = Date.now()
    this._scheduleReconnect()
  }

  private _scheduleReconnect(): void {
    if (this._reconnectTimer) return
    if (this._closedByUser || this._disposed) return
    const backoff =
      RECONNECT_BACKOFF_MS[Math.min(this._reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1)]!
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null
      if (this._closedByUser || this._disposed) return
      if (Date.now() - this._reconnectionStart >= ProtocolConstants.ReconnectionGraceTime) {
        this._fireClose()
        return
      }
      this._reconnectAttempt++
      void this._attemptReconnect()
    }, backoff)
    this._reconnectTimer.unref?.()
  }

  private async _attemptReconnect(): Promise<void> {
    try {
      const socket = await this._opts.connectSocket()
      this._reconnectSocket = socket
      let residual: Uint8Array
      try {
        residual = (await performClientHandshake(socket, this._opts.buildRequest(true))).residual
      } catch (err) {
        this._reconnectSocket = null
        socket.dispose()
        throw err
      }
      if (this._closedByUser || this._disposed) {
        this._reconnectSocket = null
        socket.dispose()
        return
      }
      this._reconnectSocket = null
      this._socket = socket
      this._protocol!.beginAcceptReconnection(socket, residual)
      this._protocol!.endAcceptReconnection()
      this._reconnectAttempt = 0
      this._opts.logger.info(`${this._opts.label} reconnected`)
    } catch (err) {
      this._reconnectSocket = null
      if (this._isPermanentHandshakeError(err)) {
        this._fireClose()
        return
      }
      this._opts.logger.warn(
        `${this._opts.label} reconnect attempt ${this._reconnectAttempt} failed: ${err instanceof Error ? err.message : String(err)}`,
      )
      this._scheduleReconnect()
    }
  }

  private _isPermanentHandshakeError(err: unknown): boolean {
    const code = (err as Partial<RemoteHandshakeError>).code
    return typeof code === 'string' && PERMANENT_RECONNECT_CODES.has(code)
  }

  private _fireClose(): void {
    if (this._closedByUser || this._disposed) return
    this._closedByUser = true
    this._onDidClose.fire()
    this.dispose()
  }

  override dispose(): void {
    if (this._disposed) return
    this._disposed = true
    this._closedByUser = true
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer)
      this._reconnectTimer = null
    }
    this._reconnectSocket?.dispose()
    this._reconnectSocket = null
    // Explicit Disconnect: tells the server to graceful-stop the forked host
    // rather than hold it in grace.
    this._protocol?.sendDisconnect()
    try {
      this._socket?.end()
    } catch {
      // already closed
    }
    this._socket = null
    super.dispose()
  }
}
