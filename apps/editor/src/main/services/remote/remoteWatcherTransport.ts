/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  IWatcherTransport that tunnels the watcher message protocol over a remote
 *  connection's fileWatcher channel instead of a local utility process. Lets the
 *  shared WatcherProcessClient reuse its seq/ack + desired/replay machinery
 *  unchanged: posts before the tunnel is ready are buffered, and a connection
 *  close surfaces as an `onExit` so the client re-spawns a transport (and replays
 *  subscriptions) against the reconnected server.
 *--------------------------------------------------------------------------------------------*/

import {
  Emitter,
  ProxyChannel,
  RemoteChannels,
  type IDisposable,
  type ILogger,
  type IRemoteWatcherTunnel,
  type WatcherHostRequest,
  type WatcherHostResponse,
} from '@universe-editor/platform'
import type { IWatcherTransport } from '@universe-editor/node-services'
import type { IRemoteConnection, IRemoteConnectionService } from './remoteConnectionMainService.js'

export class RemoteWatcherTransport implements IWatcherTransport {
  private readonly _onMessage = new Emitter<WatcherHostResponse>()
  readonly onMessage = this._onMessage.event
  private readonly _onExit = new Emitter<number | undefined>()
  readonly onExit = this._onExit.event

  private _tunnel: IRemoteWatcherTunnel | null = null
  private _pending: WatcherHostRequest[] = []
  private _subs: IDisposable[] = []
  private _disposed = false

  constructor(
    private readonly _authority: string,
    private readonly _connections: IRemoteConnectionService,
    private readonly _logger: ILogger,
  ) {
    void this._connections.getConnection(this._authority).then(
      (conn) => this._attach(conn),
      (err) => this._fail(err instanceof Error ? err.message : String(err)),
    )
  }

  private _attach(conn: IRemoteConnection): void {
    if (this._disposed) return
    const tunnel = ProxyChannel.toService<IRemoteWatcherTunnel>(
      conn.getChannel(RemoteChannels.FileWatcher),
    )
    this._tunnel = tunnel
    this._subs.push(
      tunnel.onMessage((msg) => this._onMessage.fire(msg)),
      conn.onDidClose(() => this._exit()),
    )
    const pending = this._pending
    this._pending = []
    for (const msg of pending) this._post(msg)
  }

  private _post(msg: WatcherHostRequest): void {
    const tunnel = this._tunnel
    if (!tunnel) return
    void tunnel.post(msg).catch((err: unknown) => {
      this._logger.warn(
        `[remote:${this._authority}] watcher post failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    })
  }

  post(msg: WatcherHostRequest): void {
    if (this._tunnel) this._post(msg)
    else this._pending.push(msg)
  }

  kill(): void {
    // No local process to kill: the connection owns the server-side watcher.
  }

  private _fail(message: string): void {
    this._logger.warn(`[remote:${this._authority}] watcher connect failed: ${message}`)
    this._exit()
  }

  private _exit(): void {
    if (this._disposed) return
    this._disposed = true
    for (const s of this._subs) s.dispose()
    this._subs = []
    this._pending = []
    this._tunnel = null
    this._onExit.fire(undefined)
    this._onMessage.dispose()
    this._onExit.dispose()
  }
}
