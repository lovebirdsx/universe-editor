/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  WatcherProcessClient — app-singleton owner of the watcher utility process.
 *  Per-window FileWatcherMainService instances register their desired
 *  subscription here (one id each); this client lazily spawns the process,
 *  matches request acks, fans events back out by id, and — the whole point —
 *  restarts the process and replays every desired subscription when the native
 *  watcher crashes, so a watcher.node fault never takes the main process down.
 *
 *  Restart storms are fused: more than MAX_RESTARTS exits within
 *  RESTART_WINDOW_MS marks the client broken; watching then degrades to the
 *  existing "watch failed → no auto-refresh" behaviour instead of looping.
 *
 *  Electron-free by design (the utilityProcess transport is injected) so node
 *  unit tests can drive it with an in-memory transport.
 *--------------------------------------------------------------------------------------------*/

import {
  createDecorator,
  createNamedLogger,
  DeferredPromise,
  Emitter,
  ILoggerService,
  type Event,
  type IDisposable,
  type ILogger,
  type WatcherErrorResponse,
  type WatcherEventsResponse,
  type WatcherHostRequest,
  type WatcherHostResponse,
} from '@universe-editor/platform'

/** Transport to one live watcher host process. Recreated on every (re)start. */
export interface IWatcherTransport {
  post(msg: WatcherHostRequest): void
  readonly onMessage: Event<WatcherHostResponse>
  /** Fires once when the host process exits, crashed or not. */
  readonly onExit: Event<number | undefined>
  kill(): void
}

export type WatcherTransportFactory = () => IWatcherTransport

const RESTART_DELAY_MS = 300
const RESTART_WINDOW_MS = 60_000
const MAX_RESTARTS = 3

export const IWatcherProcessService = createDecorator<WatcherProcessClient>('watcherProcess')

export class WatcherProcessClient implements IDisposable {
  declare readonly _serviceBrand: undefined

  private readonly _logger: ILogger

  private readonly _onFileEvents = new Emitter<WatcherEventsResponse>()
  readonly onFileEvents: Event<WatcherEventsResponse> = this._onFileEvents.event

  private readonly _onWatchError = new Emitter<WatcherErrorResponse>()
  readonly onWatchError: Event<WatcherErrorResponse> = this._onWatchError.event

  /** Fires after a crash-restart finished replaying subscriptions. */
  private readonly _onDidRestart = new Emitter<void>()
  readonly onDidRestart: Event<void> = this._onDidRestart.event

  private readonly _desired = new Map<number, { dir: string; ignore: readonly string[] }>()
  private readonly _pending = new Map<number, DeferredPromise<void>>()
  private _transport: IWatcherTransport | null = null
  private _transportDisposables: IDisposable[] = []
  private _restartTimer: NodeJS.Timeout | null = null
  private _restartTimes: number[] = []
  private _seq = 0
  private _idCounter = 1
  private _broken = false
  private _disposed = false

  constructor(
    private readonly _createTransport: WatcherTransportFactory,
    @ILoggerService loggerService?: ILoggerService,
  ) {
    this._logger = createNamedLogger(loggerService, { id: 'fileWatcher', name: 'File Watcher' })
  }

  /** One stable id per FileWatcherMainService instance. */
  allocateId(): number {
    return this._idCounter++
  }

  async watch(id: number, dir: string, ignore: readonly string[]): Promise<void> {
    this._desired.set(id, { dir, ignore })
    if (this._broken) throw new Error('watcher host is broken (crash loop); watching disabled')
    await this._request({ kind: 'subscribe', seq: this._nextSeq(), id, dir, ignore })
  }

  async unwatch(id: number): Promise<void> {
    this._desired.delete(id)
    // Nothing to tear down unless a host is actually running.
    if (!this._transport || this._broken) return
    await this._request({ kind: 'unsubscribe', seq: this._nextSeq(), id })
  }

  private _nextSeq(): number {
    return this._seq++
  }

  private _request(msg: WatcherHostRequest): Promise<void> {
    const transport = this._ensureTransport()
    const pending = new DeferredPromise<void>()
    this._pending.set(msg.seq, pending)
    transport.post(msg)
    return pending.p
  }

  private _ensureTransport(): IWatcherTransport {
    if (this._transport) return this._transport
    const transport = this._createTransport()
    this._transport = transport
    this._transportDisposables.push(
      transport.onMessage((msg) => this._onHostMessage(msg)),
      transport.onExit((code) => this._onHostExit(transport, code)),
    )
    return transport
  }

  private _onHostMessage(msg: WatcherHostResponse): void {
    switch (msg.kind) {
      case 'ack': {
        const pending = this._pending.get(msg.seq)
        if (!pending) return
        this._pending.delete(msg.seq)
        if (msg.error !== undefined) pending.error(new Error(msg.error))
        else pending.complete()
        break
      }
      case 'events':
        this._onFileEvents.fire(msg)
        break
      case 'watch-error':
        this._onWatchError.fire(msg)
        break
    }
  }

  private _onHostExit(transport: IWatcherTransport, code: number | undefined): void {
    // A stale exit from a transport we already replaced must not tear down the
    // live one (kill() during restart can race the new spawn).
    if (this._transport !== transport) return
    this._dropTransport()
    for (const pending of this._pending.values()) {
      pending.error(new Error(`watcher host exited (code=${code ?? 'unknown'})`))
    }
    this._pending.clear()
    if (this._disposed || this._desired.size === 0) return

    const now = Date.now()
    this._restartTimes = this._restartTimes.filter((t) => now - t < RESTART_WINDOW_MS)
    this._restartTimes.push(now)
    if (this._restartTimes.length > MAX_RESTARTS) {
      this._broken = true
      this._logger.error(
        `watcher host crashed ${this._restartTimes.length} times within ${RESTART_WINDOW_MS}ms; giving up (watching disabled until app restart)`,
      )
      return
    }

    this._logger.warn(
      `watcher host exited (code=${code ?? 'unknown'}); restarting and replaying ${this._desired.size} subscription(s)`,
    )
    this._restartTimer = setTimeout(() => {
      this._restartTimer = null
      void this._replay()
    }, RESTART_DELAY_MS)
  }

  private async _replay(): Promise<void> {
    if (this._disposed || this._broken) return
    // Re-read the live desired entry per id: a watch() racing the replay must
    // win, and the host's same-id replace semantics keep duplicates harmless.
    for (const id of Array.from(this._desired.keys())) {
      const entry = this._desired.get(id)
      if (!entry) continue
      try {
        await this._request({
          kind: 'subscribe',
          seq: this._nextSeq(),
          id,
          dir: entry.dir,
          ignore: entry.ignore,
        })
      } catch (err) {
        this._logger.warn(
          `replay watch failed ${entry.dir}`,
          err instanceof Error ? err.message : String(err),
        )
      }
    }
    if (!this._disposed && !this._broken) this._onDidRestart.fire()
  }

  private _dropTransport(): void {
    for (const d of this._transportDisposables) d.dispose()
    this._transportDisposables = []
    this._transport = null
  }

  dispose(): void {
    this._disposed = true
    if (this._restartTimer) {
      clearTimeout(this._restartTimer)
      this._restartTimer = null
    }
    const transport = this._transport
    this._dropTransport()
    transport?.kill()
    for (const pending of this._pending.values()) {
      pending.error(new Error('watcher client disposed'))
    }
    this._pending.clear()
    this._onFileEvents.dispose()
    this._onWatchError.dispose()
    this._onDidRestart.dispose()
  }
}
