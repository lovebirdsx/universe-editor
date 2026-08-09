/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Production IWatcherTransport: forks the watcher host as an Electron utility
 *  process (out/main/watcherHost.js, its own electron-vite input). The only
 *  electron-coupled piece of the watcher-process stack — kept separate so
 *  WatcherProcessClient and the services above it stay node-testable.
 *--------------------------------------------------------------------------------------------*/

import { utilityProcess } from 'electron'
import { Emitter, type IDisposable, type ILogger } from '@universe-editor/platform'
import type { IWatcherTransport, WatcherTransportFactory } from './watcherProcessClient.js'
import type { WatcherHostRequest, WatcherHostResponse } from './watcherProtocol.js'
import { processRoleRegistry } from '../process/processRoleRegistry.js'

export function createWatcherUtilityTransportFactory(
  entryPath: string,
  logger: ILogger,
): WatcherTransportFactory {
  return (): IWatcherTransport => {
    const child = utilityProcess.fork(entryPath, [], {
      serviceName: 'universe-editor-file-watcher',
      stdio: 'pipe',
    })
    // pid 在 'spawn' 事件后才可用；崩溃自愈重启会重新走本工厂，自动重登记。
    let roleRegistration: IDisposable | undefined
    const registerRole = (): void => {
      if (roleRegistration !== undefined || child.pid === undefined) return
      roleRegistration = processRoleRegistry.register(child.pid, {
        role: 'utility',
        label: 'file-watcher',
      })
    }
    registerRole()
    child.once('spawn', registerRole)
    const onMessage = new Emitter<WatcherHostResponse>()
    const onExit = new Emitter<number | undefined>()
    child.stdout?.on('data', (d: Buffer) => logger.debug(`[watcher-host] ${String(d).trim()}`))
    child.stderr?.on('data', (d: Buffer) => logger.warn(`[watcher-host] ${String(d).trim()}`))
    child.on('message', (msg) => onMessage.fire(msg as WatcherHostResponse))
    child.once('exit', (code) => {
      roleRegistration?.dispose()
      onExit.fire(code)
      onMessage.dispose()
      onExit.dispose()
    })
    return {
      post: (msg: WatcherHostRequest) => child.postMessage(msg),
      onMessage: onMessage.event,
      onExit: onExit.event,
      // kill 时同步摘除登记：主进程退出路径上 child 的 'exit' 事件来不及
      // 派发（进程已死但事件循环不再 tick），仅靠 'exit' 回调会把登记句柄
      // 留成泄漏。'exit' 里的再 dispose 靠 toDisposable 幂等兜底。
      kill: () => {
        roleRegistration?.dispose()
        roleRegistration = undefined
        void child.kill()
      },
    }
  }
}
