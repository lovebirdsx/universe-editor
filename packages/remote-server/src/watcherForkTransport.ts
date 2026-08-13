/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Production IWatcherTransport for the remote server: forks the watcher child
 *  (watcherChild.js) via child_process.fork and pumps the watcher message
 *  protocol over the IPC channel. Mirrors apps/editor's watcherUtilityTransport
 *  (Electron utilityProcess) but for plain node, so the server daemon keeps the
 *  parcel-native WatcherHost out of its own process.
 *--------------------------------------------------------------------------------------------*/

import { fork, type ChildProcess } from 'node:child_process'
import {
  Emitter,
  type ILogger,
  type WatcherHostRequest,
  type WatcherHostResponse,
} from '@universe-editor/platform'
import type { IWatcherTransport } from '@universe-editor/node-services'

export class ForkedWatcherTransport implements IWatcherTransport {
  private readonly _onMessage = new Emitter<WatcherHostResponse>()
  readonly onMessage = this._onMessage.event

  private readonly _onExit = new Emitter<number | undefined>()
  readonly onExit = this._onExit.event

  private readonly _child: ChildProcess
  private _exited = false

  constructor(entryPath: string, logger: ILogger) {
    const child = fork(entryPath, [], {
      // stdin stays piped (not ignored) so the child sees an EOF and exits when
      // the daemon dies; stdout/stderr are logged, and 'ipc' carries the protocol.
      stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
    })
    this._child = child

    child.stdout?.on('data', (d: Buffer) => logger.debug(`[watcher-host] ${String(d).trim()}`))
    child.stderr?.on('data', (d: Buffer) => logger.warn(`[watcher-host] ${String(d).trim()}`))
    child.on('message', (msg: unknown) => this._onMessage.fire(msg as WatcherHostResponse))
    child.once('error', (err) => {
      logger.warn(`[watcher-host] spawn error: ${err.message}`)
      this._exit(undefined)
    })
    child.once('exit', (code, signal) => {
      if (signal) logger.warn(`[watcher-host] exited by signal ${signal}`)
      this._exit(code ?? undefined)
    })
  }

  post(msg: WatcherHostRequest): void {
    if (this._child.connected) {
      this._child.send(msg)
    }
  }

  kill(): void {
    if (!this._exited) {
      this._child.kill()
    }
  }

  private _exit(code: number | undefined): void {
    if (this._exited) return
    this._exited = true
    this._onExit.fire(code)
    this._onMessage.dispose()
    this._onExit.dispose()
  }
}
