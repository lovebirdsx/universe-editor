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
  type IFileService,
  type IHostServiceWire,
  type IStorageService,
  type IWorkspaceServiceWire,
  ProxyChannel,
} from '@universe-editor/platform'
import { ServiceChannels } from '../../shared/ipc/channelNames.js'
import type { IPingService } from '../../shared/ipc/services.js'
import { createMainProtocolForWindow } from './electronProtocol.js'
import { MainHostService } from '../services/host/hostMainService.js'

export interface SharedMainServices {
  readonly storage: IStorageService
  readonly ping: IPingService
  readonly fileSystem: IFileService
  readonly workspace: IWorkspaceServiceWire
}

/**
 * Bind a ChannelServer to a window's protocol and register the window-scoped
 * `MainHostService` alongside the shared singletons. The returned disposable
 * tears down the server + protocol; call it on window close.
 */
export function bootstrapWindowIpc(
  win: BrowserWindow,
  shared: SharedMainServices,
): IDisposable & { host: IHostServiceWire } {
  const { protocol, disposable: protoDisposable } = createMainProtocolForWindow(win)
  const server = new ChannelServer(protocol)
  const host = new MainHostService(win)

  server.registerChannel(ServiceChannels.Host, ProxyChannel.fromService(host))
  server.registerChannel(ServiceChannels.Storage, ProxyChannel.fromService(shared.storage))
  server.registerChannel(ServiceChannels.Ping, ProxyChannel.fromService(shared.ping))
  server.registerChannel(ServiceChannels.FileSystem, ProxyChannel.fromService(shared.fileSystem))
  server.registerChannel(ServiceChannels.Workspace, ProxyChannel.fromService(shared.workspace))

  const all = combinedDisposable(server, host, protoDisposable)
  return Object.assign(all, { host })
}
