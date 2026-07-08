/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Central table of cross-process services: each is a ProxyChannel-derived proxy
 *  bound to a main-side channel. Kept together (rather than registerSingleton'd)
 *  because they are channel bindings, not constructible classes.
 *
 *  The binding is data-driven (`PROXY_SERVICE_BINDINGS`): a missing wire-up
 *  becomes a missing table row (easy to review + testable) rather than a missing
 *  `services.set(...)` call buried in a long function. A test asserts every entry
 *  points at a real `ServiceChannels` name.
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
  type ServiceIdentifier,
} from '@universe-editor/platform'
import { ServiceChannels, type ServiceChannelName } from '../../shared/ipc/channelNames.js'
import {
  ILogFilesService,
  IPerformanceMarksService,
  IPingService,
  IUsageService,
  IExchangeRateService,
} from '../../shared/ipc/services.js'
import { IResourceAccessService } from '../../shared/ipc/resourceAccessService.js'
import { IAcpHostService } from '../../shared/ipc/acpHostService.js'
import { IExtensionHostService } from '../../shared/ipc/extensionHostService.js'
import { IExtensionManagementService } from '../../shared/ipc/extensionManagementService.js'
import { IExtensionGalleryService } from '../../shared/ipc/extensionGalleryService.js'
import { IAcpTerminalService } from '../../shared/ipc/acpTerminalService.js'
import { ITerminalService } from '../../shared/ipc/terminalService.js'
import { IClaudeBinaryService } from '../../shared/ipc/claudeBinaryService.js'
import { ICodexBinaryService } from '../../shared/ipc/codexBinaryService.js'
import { ICodexConfigService } from '../../shared/ipc/codexConfigService.js'
import { IUpdateService } from '../../shared/ipc/updateService.js'
import { IReleaseNotesService } from '../../shared/ipc/releaseNotesService.js'
import { IDocsService } from '../../shared/ipc/docsService.js'
import { ITextSearchMainService } from '../../shared/ipc/textSearchService.js'
import { ISessionSwitcherService } from '../../shared/ipc/sessionSwitcher.js'
import { IConfigLocationService } from '../../shared/ipc/configLocationService.js'

interface ProxyServiceBinding {
  readonly id: ServiceIdentifier<object>
  readonly channel: ServiceChannelName
  /** Synchronous, pre-resolved properties served locally instead of via the channel. */
  readonly properties?: (platform: HostPlatform) => ReadonlyMap<string, unknown>
}

/**
 * Every cross-process proxy service binding. Order is irrelevant — each row maps
 * a service identifier to its channel. Add a new ProxyChannel service by adding
 * one row here (and the channel name in `ServiceChannels`).
 */
export const PROXY_SERVICE_BINDINGS: readonly ProxyServiceBinding[] = [
  {
    id: IHostService,
    channel: ServiceChannels.Host,
    properties: (platform) => new Map<string, unknown>([['platform', platform]]),
  },
  { id: IStorageService, channel: ServiceChannels.Storage },
  { id: IPingService, channel: ServiceChannels.Ping },
  { id: IFileService, channel: ServiceChannels.FileSystem },
  { id: IFileSearchService, channel: ServiceChannels.FileSearch },
  { id: ITextSearchMainService, channel: ServiceChannels.TextSearch },
  { id: IFileWatcherService, channel: ServiceChannels.FileWatcher },
  { id: IUserDataFilesService, channel: ServiceChannels.UserData },
  { id: IConfigLocationService, channel: ServiceChannels.ConfigLocation },
  { id: ILogFilesService, channel: ServiceChannels.LogFiles },
  { id: IAcpHostService, channel: ServiceChannels.AcpHost },
  { id: IExtensionHostService, channel: ServiceChannels.ExtensionHost },
  { id: IExtensionManagementService, channel: ServiceChannels.ExtensionManagement },
  { id: IExtensionGalleryService, channel: ServiceChannels.ExtensionGallery },
  { id: IAcpTerminalService, channel: ServiceChannels.AcpTerminal },
  { id: ITerminalService, channel: ServiceChannels.Terminal },
  { id: IClaudeBinaryService, channel: ServiceChannels.ClaudeBinary },
  { id: ICodexBinaryService, channel: ServiceChannels.CodexBinary },
  { id: ICodexConfigService, channel: ServiceChannels.CodexConfig },
  { id: IUpdateService, channel: ServiceChannels.Update },
  { id: IReleaseNotesService, channel: ServiceChannels.ReleaseNotes },
  { id: IDocsService, channel: ServiceChannels.Docs },
  { id: IWindowsService, channel: ServiceChannels.Window },
  { id: IPerformanceMarksService, channel: ServiceChannels.Performance },
  { id: ISessionSwitcherService, channel: ServiceChannels.SessionSwitcher },
  { id: IUsageService, channel: ServiceChannels.Usage },
  { id: IExchangeRateService, channel: ServiceChannels.ExchangeRate },
  { id: IResourceAccessService, channel: ServiceChannels.ResourceAccess },
]

export function registerProxyChannelServices(
  services: ServiceCollection,
  ipc: IIpcService,
  platform: HostPlatform,
): void {
  for (const { id, channel, properties } of PROXY_SERVICE_BINDINGS) {
    const options = properties ? { properties: properties(platform) } : undefined
    services.set(id, ProxyChannel.toService(ipc.getChannel(channel), options))
  }
}
