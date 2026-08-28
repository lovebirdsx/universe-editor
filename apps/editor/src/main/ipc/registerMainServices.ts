/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Per-window IPC bootstrap. Wires the Electron protocol into a ChannelServer
 *  and registers cross-process service channels via ProxyChannel.fromService.
 *--------------------------------------------------------------------------------------------*/

import { type BrowserWindow } from 'electron'
import {
  ChannelPair,
  combinedDisposable,
  type IDisposable,
  type IWindowsService,
  ProxyChannel,
} from '@universe-editor/platform'
import { ServiceChannels } from '../../shared/ipc/channelNames.js'
import { type IRendererLifecycleService } from '../../shared/ipc/lifecycleService.js'
import { type IRendererSessionsService } from '../../shared/ipc/sessionSwitcher.js'
import { createWindowScopedSessionSwitcher } from '../services/sessionSwitcher/sessionSwitcherMainService.js'
import { createWindowScopedAcpHost } from '../services/acpHost/acpHostMainService.js'
import { createWindowScopedExtensionHost } from '../services/extensionHost/extensionHostMainService.js'
import { createMainProtocolForWindow } from './electronProtocol.js'
import type { ApplicationServices, WindowScopedServices } from '../window/scopedServicesFactory.js'
import { createWindowScopedUpdateService } from '../services/update/updateMainService.js'
import { createWindowScopedErrorSink } from '../services/telemetry/errorSinkMainService.js'

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
  // One decode per frame, routed by message type (see ChannelPair).
  const pair = new ChannelPair(protocol)
  const { client, server } = pair

  server.registerChannel(ServiceChannels.Host, ProxyChannel.fromService(window.host))
  server.registerChannel(ServiceChannels.Storage, ProxyChannel.fromService(window.storage))
  server.registerChannel(ServiceChannels.Ping, ProxyChannel.fromService(app.ping))
  server.registerChannel(ServiceChannels.FileSystem, ProxyChannel.fromService(app.fileSystem))
  server.registerChannel(ServiceChannels.FileClipboard, ProxyChannel.fromService(app.fileClipboard))
  server.registerChannel(ServiceChannels.FileSearch, ProxyChannel.fromService(app.fileSearch))
  server.registerChannel(ServiceChannels.TextSearch, ProxyChannel.fromService(app.textSearch))
  server.registerChannel(ServiceChannels.FileWatcher, ProxyChannel.fromService(window.fileWatcher))
  server.registerChannel(ServiceChannels.Workspace, ProxyChannel.fromService(window.workspace))
  server.registerChannel(ServiceChannels.UserData, ProxyChannel.fromService(window.userData))
  server.registerChannel(
    ServiceChannels.ConfigLocation,
    ProxyChannel.fromService(app.configLocation),
  )
  server.registerChannel(ServiceChannels.Terminal, ProxyChannel.fromService(window.terminal))
  server.registerChannel(ServiceChannels.Window, ProxyChannel.fromService(windows))
  server.registerChannel(ServiceChannels.LogFiles, ProxyChannel.fromService(window.logFiles))
  server.registerChannel(
    ServiceChannels.AcpHost,
    ProxyChannel.fromService(createWindowScopedAcpHost(app.acpHost, win.id)),
  )
  server.registerChannel(
    ServiceChannels.ExtensionHost,
    ProxyChannel.fromService(createWindowScopedExtensionHost(app.extensionHost, win.id)),
  )
  server.registerChannel(
    ServiceChannels.ExtensionManagement,
    ProxyChannel.fromService(app.extensionManagement),
  )
  server.registerChannel(
    ServiceChannels.ExtensionGallery,
    ProxyChannel.fromService(app.extensionGallery),
  )
  server.registerChannel(ServiceChannels.AcpTerminal, ProxyChannel.fromService(app.acpTerminal))
  server.registerChannel(ServiceChannels.ClaudeBinary, ProxyChannel.fromService(app.claudeBinary))
  server.registerChannel(ServiceChannels.ClaudeConfig, ProxyChannel.fromService(app.claudeConfig))
  server.registerChannel(ServiceChannels.CodexBinary, ProxyChannel.fromService(app.codexBinary))
  server.registerChannel(ServiceChannels.CodexConfig, ProxyChannel.fromService(app.codexConfig))
  server.registerChannel(ServiceChannels.Log, ProxyChannel.fromService(window.logChannel))
  server.registerChannel(
    ServiceChannels.DisposableLeak,
    ProxyChannel.fromService(app.disposableLeak),
  )
  server.registerChannel(
    ServiceChannels.Update,
    ProxyChannel.fromService(createWindowScopedUpdateService(app.update, win.id)),
  )
  server.registerChannel(ServiceChannels.ReleaseNotes, ProxyChannel.fromService(app.releaseNotes))
  server.registerChannel(ServiceChannels.Docs, ProxyChannel.fromService(app.docs))
  server.registerChannel(ServiceChannels.Performance, ProxyChannel.fromService(app.performance))
  server.registerChannel(ServiceChannels.AiModel, ProxyChannel.fromService(app.aiModel))
  server.registerChannel(ServiceChannels.AiDebug, ProxyChannel.fromService(app.aiDebug))
  server.registerChannel(ServiceChannels.RemoteSchema, ProxyChannel.fromService(app.remoteSchema))
  server.registerChannel(ServiceChannels.RemoteStatus, ProxyChannel.fromService(app.remoteStatus))
  server.registerChannel(ServiceChannels.ExchangeRate, ProxyChannel.fromService(app.exchangeRate))
  server.registerChannel(
    ServiceChannels.ResourceAccess,
    ProxyChannel.fromService(app.resourceAccess),
  )
  server.registerChannel(
    ServiceChannels.EnvironmentSnapshot,
    ProxyChannel.fromService(app.environmentSnapshot),
  )
  server.registerChannel(
    ServiceChannels.ErrorSink,
    ProxyChannel.fromService(createWindowScopedErrorSink(app.errorSink, win.id)),
  )
  server.registerChannel(ServiceChannels.Diagnostics, ProxyChannel.fromService(app.diagnostics))
  server.registerChannel(ServiceChannels.BugRecorder, ProxyChannel.fromService(app.bugRecorder))
  server.registerChannel(ServiceChannels.IssueReporter, ProxyChannel.fromService(app.issueReporter))
  server.registerChannel(
    ServiceChannels.ProcessMonitor,
    ProxyChannel.fromService(app.processMonitor),
  )
  server.registerChannel(
    ServiceChannels.SessionSwitcher,
    ProxyChannel.fromService(createWindowScopedSessionSwitcher(app.sessionSwitcher, win.id)),
  )

  const rendererLifecycle = ProxyChannel.toService<IRendererLifecycleService>(
    client.getChannel(ServiceChannels.Lifecycle),
  )
  const rendererSessions = ProxyChannel.toService<IRendererSessionsService>(
    client.getChannel(ServiceChannels.RendererSessions),
  )

  return {
    disposable: combinedDisposable(pair, protoDisposable),
    rendererLifecycle,
    rendererSessions,
  }
}
