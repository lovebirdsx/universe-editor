/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Per-window IPC bootstrap. Wires the Electron protocol into a ChannelServer
 *  and registers cross-process service channels via ProxyChannel.fromService.
 *--------------------------------------------------------------------------------------------*/

import { type BrowserWindow } from 'electron'
import {
  ChannelServer,
  combinedDisposable,
  type IDisposable,
  type IHostServiceWire,
  ProxyChannel,
} from '@universe-editor/platform'
import { ServiceChannels } from '../../shared/ipc/channelNames.js'
import { createMainProtocolForWindow } from './electronProtocol.js'
import type { ApplicationServices, WindowScopedServices } from '../window/scopedServicesFactory.js'

/**
 * Bind a ChannelServer to a window's protocol and register the application-singleton
 * services alongside the per-window services. The returned disposable tears down
 * the server + protocol; call it on window close.
 */
export function bootstrapWindowIpc(
  win: BrowserWindow,
  app: ApplicationServices,
  window: WindowScopedServices,
): IDisposable & { host: IHostServiceWire } {
  const { protocol, disposable: protoDisposable } = createMainProtocolForWindow(win)
  const server = new ChannelServer(protocol)

  server.registerChannel(ServiceChannels.Host, ProxyChannel.fromService(window.host))
  server.registerChannel(ServiceChannels.Storage, ProxyChannel.fromService(app.storage))
  server.registerChannel(ServiceChannels.Ping, ProxyChannel.fromService(app.ping))
  server.registerChannel(ServiceChannels.FileSystem, ProxyChannel.fromService(app.fileSystem))
  server.registerChannel(ServiceChannels.FileWatcher, ProxyChannel.fromService(app.fileWatcher))
  server.registerChannel(ServiceChannels.Workspace, ProxyChannel.fromService(app.workspace))
  server.registerChannel(ServiceChannels.UserData, ProxyChannel.fromService(app.userData))
  server.registerChannel(ServiceChannels.Log, ProxyChannel.fromService(window.logChannel))

  const all = combinedDisposable(server, protoDisposable)
  return Object.assign(all, { host: window.host })
}
