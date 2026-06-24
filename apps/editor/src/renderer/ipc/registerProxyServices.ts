/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Central table of cross-process services: each is a ProxyChannel-derived proxy
 *  bound to a main-side channel. Kept together (rather than registerSingleton'd)
 *  because they are channel bindings, not constructible classes.
 *--------------------------------------------------------------------------------------------*/

import {
  IFileService,
  IFileSearchService,
  IFileWatcherService,
  IHostService,
  IStorageService,
  IUserDataFilesService,
  IWindowsService,
  ProxyChannel,
  ServiceCollection,
  type HostPlatform,
  type IIpcService,
} from '@universe-editor/platform'
import { ServiceChannels } from '../../shared/ipc/channelNames.js'
import {
  ILogFilesService,
  IPerformanceMarksService,
  IPingService,
  IUsageService,
} from '../../shared/ipc/services.js'
import { IAcpHostService } from '../../shared/ipc/acpHostService.js'
import { IExtensionHostService } from '../../shared/ipc/extensionHostService.js'
import { IAcpTerminalService } from '../../shared/ipc/acpTerminalService.js'
import { ITerminalService } from '../../shared/ipc/terminalService.js'
import { IClaudeBinaryService } from '../../shared/ipc/claudeBinaryService.js'
import { ICodexBinaryService } from '../../shared/ipc/codexBinaryService.js'
import { ICodexConfigService } from '../../shared/ipc/codexConfigService.js'
import { IUpdateService } from '../../shared/ipc/updateService.js'
import { IReleaseNotesService } from '../../shared/ipc/releaseNotesService.js'
import { ITextSearchMainService } from '../../shared/ipc/textSearchService.js'
import { ISessionSwitcherService } from '../../shared/ipc/sessionSwitcher.js'
import { IConfigLocationService } from '../../shared/ipc/configLocationService.js'

export function registerProxyChannelServices(
  services: ServiceCollection,
  ipc: IIpcService,
  platform: HostPlatform,
): void {
  services.set(
    IHostService,
    ProxyChannel.toService<IHostService>(ipc.getChannel(ServiceChannels.Host), {
      properties: new Map<string, unknown>([['platform', platform]]),
    }),
  )
  services.set(
    IStorageService,
    ProxyChannel.toService<IStorageService>(ipc.getChannel(ServiceChannels.Storage)),
  )
  services.set(
    IPingService,
    ProxyChannel.toService<IPingService>(ipc.getChannel(ServiceChannels.Ping)),
  )
  services.set(
    IFileService,
    ProxyChannel.toService<IFileService>(ipc.getChannel(ServiceChannels.FileSystem)),
  )
  services.set(
    IFileSearchService,
    ProxyChannel.toService<IFileSearchService>(ipc.getChannel(ServiceChannels.FileSearch)),
  )
  services.set(
    ITextSearchMainService,
    ProxyChannel.toService<ITextSearchMainService>(ipc.getChannel(ServiceChannels.TextSearch)),
  )
  services.set(
    IFileWatcherService,
    ProxyChannel.toService<IFileWatcherService>(ipc.getChannel(ServiceChannels.FileWatcher)),
  )
  services.set(
    IUserDataFilesService,
    ProxyChannel.toService<IUserDataFilesService>(ipc.getChannel(ServiceChannels.UserData)),
  )
  services.set(
    IConfigLocationService,
    ProxyChannel.toService<IConfigLocationService>(ipc.getChannel(ServiceChannels.ConfigLocation)),
  )
  services.set(
    ILogFilesService,
    ProxyChannel.toService<ILogFilesService>(ipc.getChannel(ServiceChannels.LogFiles)),
  )
  services.set(
    IAcpHostService,
    ProxyChannel.toService<IAcpHostService>(ipc.getChannel(ServiceChannels.AcpHost)),
  )
  services.set(
    IExtensionHostService,
    ProxyChannel.toService<IExtensionHostService>(ipc.getChannel(ServiceChannels.ExtensionHost)),
  )
  services.set(
    IAcpTerminalService,
    ProxyChannel.toService<IAcpTerminalService>(ipc.getChannel(ServiceChannels.AcpTerminal)),
  )
  services.set(
    ITerminalService,
    ProxyChannel.toService<ITerminalService>(ipc.getChannel(ServiceChannels.Terminal)),
  )
  services.set(
    IClaudeBinaryService,
    ProxyChannel.toService<IClaudeBinaryService>(ipc.getChannel(ServiceChannels.ClaudeBinary)),
  )
  services.set(
    ICodexBinaryService,
    ProxyChannel.toService<ICodexBinaryService>(ipc.getChannel(ServiceChannels.CodexBinary)),
  )
  services.set(
    ICodexConfigService,
    ProxyChannel.toService<ICodexConfigService>(ipc.getChannel(ServiceChannels.CodexConfig)),
  )
  services.set(
    IUpdateService,
    ProxyChannel.toService<IUpdateService>(ipc.getChannel(ServiceChannels.Update)),
  )
  services.set(
    IReleaseNotesService,
    ProxyChannel.toService<IReleaseNotesService>(ipc.getChannel(ServiceChannels.ReleaseNotes)),
  )
  services.set(
    IWindowsService,
    ProxyChannel.toService<IWindowsService>(ipc.getChannel(ServiceChannels.Window)),
  )
  services.set(
    IPerformanceMarksService,
    ProxyChannel.toService<IPerformanceMarksService>(ipc.getChannel(ServiceChannels.Performance)),
  )
  services.set(
    ISessionSwitcherService,
    ProxyChannel.toService<ISessionSwitcherService>(
      ipc.getChannel(ServiceChannels.SessionSwitcher),
    ),
  )
  services.set(
    IUsageService,
    ProxyChannel.toService<IUsageService>(ipc.getChannel(ServiceChannels.Usage)),
  )
}
