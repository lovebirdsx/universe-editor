/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Per-window IPC bootstrap. Wires the Electron protocol into a ChannelServer
 *  and registers cross-process service channels via ProxyChannel.fromService.
 *--------------------------------------------------------------------------------------------*/

import { type BrowserWindow } from 'electron'
import {
  ChannelClient,
  ChannelServer,
  combinedDisposable,
  type IDisposable,
  type IWindowsService,
  ProxyChannel,
} from '@universe-editor/platform'
import { ServiceChannels } from '../../shared/ipc/channelNames.js'
import { type IRendererLifecycleService } from '../../shared/ipc/lifecycleService.js'
import { type IRendererSessionsService } from '../../shared/ipc/sessionSwitcher.js'
import { createMainProtocolForWindow } from './electronProtocol.js'
import type { ApplicationServices, WindowScopedServices } from '../window/scopedServicesFactory.js'

export interface WindowIpcBootstrap {
  readonly disposable: IDisposable
  /** Reverse proxy: lets main invoke the renderer's lifecycle veto chain. */
  readonly rendererLifecycle: IRendererLifecycleService
  /** Reverse proxy: lets main list/reveal this renderer's live sessions. */
  readonly rendererSessions: IRendererSessionsService
}

/**
 * Bind a ChannelServer to a window's protocol and register the application-singleton
 * services alongside the per-window services. Also opens a reverse ChannelClient on
 * the same (full-duplex) protocol so main can call renderer-implemented channels.
 * The returned disposable tears down the server + client + protocol; call it on
 * window close.
 */
export function bootstrapWindowIpc(
  win: BrowserWindow,
  app: ApplicationServices,
  window: WindowScopedServices,
  windows: IWindowsService,
): WindowIpcBootstrap {
  const { protocol, disposable: protoDisposable } = createMainProtocolForWindow(win)
  const server = new ChannelServer(protocol)
  const client = new ChannelClient(protocol)

  server.registerChannel(ServiceChannels.Host, ProxyChannel.fromService(window.host))
  server.registerChannel(ServiceChannels.Storage, ProxyChannel.fromService(window.storage))
  server.registerChannel(ServiceChannels.Ping, ProxyChannel.fromService(app.ping))
  server.registerChannel(ServiceChannels.FileSystem, ProxyChannel.fromService(app.fileSystem))
  server.registerChannel(ServiceChannels.FileSearch, ProxyChannel.fromService(app.fileSearch))
  server.registerChannel(ServiceChannels.TextSearch, ProxyChannel.fromService(app.textSearch))
  server.registerChannel(ServiceChannels.FileWatcher, ProxyChannel.fromService(app.fileWatcher))
  server.registerChannel(ServiceChannels.Workspace, ProxyChannel.fromService(window.workspace))
  server.registerChannel(ServiceChannels.UserData, ProxyChannel.fromService(window.userData))
  server.registerChannel(ServiceChannels.Terminal, ProxyChannel.fromService(window.terminal))
  server.registerChannel(ServiceChannels.Window, ProxyChannel.fromService(windows))
  server.registerChannel(ServiceChannels.LogFiles, ProxyChannel.fromService(app.logFiles))
  server.registerChannel(ServiceChannels.AcpHost, ProxyChannel.fromService(app.acpHost))
  server.registerChannel(ServiceChannels.ExtensionHost, ProxyChannel.fromService(app.extensionHost))
  server.registerChannel(
    ServiceChannels.MarkdownLanguage,
    ProxyChannel.fromService(app.markdownLanguage),
  )
  server.registerChannel(
    ServiceChannels.TypescriptLanguage,
    ProxyChannel.fromService(app.typescriptLanguage),
  )
  server.registerChannel(ServiceChannels.AcpTerminal, ProxyChannel.fromService(app.acpTerminal))
  server.registerChannel(ServiceChannels.ClaudeBinary, ProxyChannel.fromService(app.claudeBinary))
  server.registerChannel(ServiceChannels.CodexBinary, ProxyChannel.fromService(app.codexBinary))
  server.registerChannel(ServiceChannels.Log, ProxyChannel.fromService(window.logChannel))
  server.registerChannel(
    ServiceChannels.DisposableLeak,
    ProxyChannel.fromService(app.disposableLeak),
  )
  server.registerChannel(ServiceChannels.Update, ProxyChannel.fromService(app.update))
  server.registerChannel(ServiceChannels.ReleaseNotes, ProxyChannel.fromService(app.releaseNotes))
  server.registerChannel(ServiceChannels.Performance, ProxyChannel.fromService(app.performance))
  server.registerChannel(
    ServiceChannels.SessionSwitcher,
    ProxyChannel.fromService(app.sessionSwitcher),
  )

  const rendererLifecycle = ProxyChannel.toService<IRendererLifecycleService>(
    client.getChannel(ServiceChannels.Lifecycle),
  )
  const rendererSessions = ProxyChannel.toService<IRendererSessionsService>(
    client.getChannel(ServiceChannels.RendererSessions),
  )

  return {
    disposable: combinedDisposable(server, client, protoDisposable),
    rendererLifecycle,
    rendererSessions,
  }
}
