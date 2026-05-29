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
  type IWindowsService,
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
  windows: IWindowsService,
): IDisposable {
  const { protocol, disposable: protoDisposable } = createMainProtocolForWindow(win)
  const server = new ChannelServer(protocol)

  server.registerChannel(ServiceChannels.Host, ProxyChannel.fromService(window.host))
  server.registerChannel(ServiceChannels.Storage, ProxyChannel.fromService(window.storage))
  server.registerChannel(ServiceChannels.Ping, ProxyChannel.fromService(app.ping))
  server.registerChannel(ServiceChannels.FileSystem, ProxyChannel.fromService(app.fileSystem))
  server.registerChannel(ServiceChannels.FileWatcher, ProxyChannel.fromService(app.fileWatcher))
  server.registerChannel(ServiceChannels.Workspace, ProxyChannel.fromService(window.workspace))
  server.registerChannel(ServiceChannels.UserData, ProxyChannel.fromService(window.userData))
  server.registerChannel(ServiceChannels.Window, ProxyChannel.fromService(windows))
  server.registerChannel(ServiceChannels.LogFiles, ProxyChannel.fromService(app.logFiles))
  server.registerChannel(ServiceChannels.AcpHost, ProxyChannel.fromService(app.acpHost))
  server.registerChannel(ServiceChannels.AcpTerminal, ProxyChannel.fromService(app.acpTerminal))
  server.registerChannel(ServiceChannels.Log, ProxyChannel.fromService(window.logChannel))
  server.registerChannel(
    ServiceChannels.DisposableLeak,
    ProxyChannel.fromService(app.disposableLeak),
  )

  return combinedDisposable(server, protoDisposable)
}
