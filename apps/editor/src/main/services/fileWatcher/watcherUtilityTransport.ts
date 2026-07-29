/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Production IWatcherTransport: forks the watcher host as an Electron utility
 *  process (out/main/watcherHost.js, its own electron-vite input). The only
 *  electron-coupled piece of the watcher-process stack — kept separate so
 *  WatcherProcessClient and the services above it stay node-testable.
 *--------------------------------------------------------------------------------------------*/

import { utilityProcess } from 'electron'
import { Emitter, type ILogger } from '@universe-editor/platform'
import type { IWatcherTransport, WatcherTransportFactory } from './watcherProcessClient.js'
import type { WatcherHostRequest, WatcherHostResponse } from './watcherProtocol.js'

export function createWatcherUtilityTransportFactory(
  entryPath: string,
  logger: ILogger,
): WatcherTransportFactory {
  return (): IWatcherTransport => {
    const child = utilityProcess.fork(entryPath, [], {
      serviceName: 'universe-editor-file-watcher',
      stdio: 'pipe',
    })
    const onMessage = new Emitter<WatcherHostResponse>()
    const onExit = new Emitter<number | undefined>()
    child.stdout?.on('data', (d: Buffer) => logger.debug(`[watcher-host] ${String(d).trim()}`))
    child.stderr?.on('data', (d: Buffer) => logger.warn(`[watcher-host] ${String(d).trim()}`))
    child.on('message', (msg) => onMessage.fire(msg as WatcherHostResponse))
    child.once('exit', (code) => {
      onExit.fire(code)
      onMessage.dispose()
      onExit.dispose()
    })
    return {
      post: (msg: WatcherHostRequest) => child.postMessage(msg),
      onMessage: onMessage.event,
      onExit: onExit.event,
      kill: () => void child.kill(),
    }
  }
}
