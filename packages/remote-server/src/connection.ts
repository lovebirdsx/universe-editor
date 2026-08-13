/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ManagementConnection — one logical client connection over a PersistentProtocol.
 *  Owns the per-connection channel layer (ChannelPair with a binary codec that
 *  translates remote-ssh <-> file) and the per-connection service set. A socket
 *  loss only signals the daemon to start its grace timer; the channel layer and
 *  services stay alive so a reconnect is transparent to the client.
 *--------------------------------------------------------------------------------------------*/

import {
  ChannelPair,
  Disposable,
  PersistentProtocol,
  ProtocolConstants,
  createBinaryCodec,
  createRemoteURITransformer,
  type IDisposable,
  type ILogger,
  type ISocket,
} from '@universe-editor/platform'
import type { PtySpawner } from '@universe-editor/node-services'
import { createRemoteServer } from './server.js'

export interface ManagementConnectionOptions {
  readonly reconnectionToken: string
  readonly authority: string
  readonly socket: ISocket
  readonly residual: Uint8Array | null
  readonly serverVersion: string
  readonly logger: ILogger
  readonly onSocketClose: (conn: ManagementConnection) => void
  /** Fake pty spawner for daemon integration tests. */
  readonly terminalSpawner?: PtySpawner
}

export class ManagementConnection extends Disposable {
  readonly reconnectionToken: string
  readonly authority: string

  private readonly _logger: ILogger
  private readonly _protocol: PersistentProtocol
  private readonly _services: IDisposable
  private _socket: ISocket
  private _disposed = false

  constructor(opts: ManagementConnectionOptions) {
    super()
    this.reconnectionToken = opts.reconnectionToken
    this.authority = opts.authority
    this._logger = opts.logger
    this._socket = opts.socket

    this._protocol = this._register(
      new PersistentProtocol({ socket: opts.socket, initialChunk: opts.residual }),
    )
    // A socket loss is NOT a permanent close: only notify the daemon to hold the
    // connection in grace. Never dispose the channel layer here.
    this._register(
      this._protocol.onSocketClose(() => {
        opts.logger.info(`[remote:${opts.authority}] management socket closed (grace period)`)
        opts.onSocketClose(this)
      }),
    )

    const pair = this._register(
      new ChannelPair(
        this._protocol,
        undefined,
        createBinaryCodec(createRemoteURITransformer(opts.authority)),
      ),
    )
    this._services = this._register(
      createRemoteServer(pair.server, opts.logger, {
        serverVersion: opts.serverVersion,
        ...(opts.terminalSpawner !== undefined ? { terminalSpawner: opts.terminalSpawner } : {}),
      }),
    )

    const budgetTimer = setInterval(() => this._checkUnacknowledgedBudget(), 5000)
    budgetTimer.unref?.()
    this._register({ dispose: () => clearInterval(budgetTimer) })

    opts.logger.info(
      `[remote:${opts.authority}] management connection established (token ${opts.reconnectionToken.slice(0, 8)}…)`,
    )
  }

  acceptReconnection(socket: ISocket, residual: Uint8Array | null): void {
    if (this._disposed) return
    const oldSocket = this._socket
    this._socket = socket
    this._protocol.beginAcceptReconnection(socket, residual)
    this._protocol.endAcceptReconnection()
    // The old socket is now detached; destroy it so the net server can finish
    // closing instead of waiting on a half-open socket.
    try {
      oldSocket.dispose()
    } catch {
      // already closed
    }
  }

  private _checkUnacknowledgedBudget(): void {
    const bytes = this._protocol.getUnacknowledgedBytes()
    if (bytes > ProtocolConstants.UnacknowledgedBytesBudget) {
      this._logger.warn(
        `[remote:${this.authority}] unacknowledged bytes ${bytes} exceeded budget ${ProtocolConstants.UnacknowledgedBytesBudget}; disposing connection`,
      )
      this.dispose()
    }
  }

  override dispose(): void {
    if (this._disposed) return
    this._disposed = true
    this._protocol.sendDisconnect()
    super.dispose()
    try {
      this._socket.dispose()
    } catch {
      // already closed
    }
  }
}
