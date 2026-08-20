/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Declarative registration of the application-singleton main services. Importing
 *  this module runs every registerSingleton(...) so the descriptors are present in
 *  the global registry before index.ts feeds them into the root ServiceCollection.
 *
 *  Mirrors the renderer's services/index.ts. These are all Eager: the bootstrap
 *  in index.ts resolves the whole ApplicationServices set at once (and per-window
 *  IPC binds them immediately), so there is nothing to gain from lazy proxies.
 *
 *  Preset instances they depend on (ILoggerService / ILogMainService /
 *  IEnvironmentMainService / IMainStorageService) are set directly on the root
 *  collection in index.ts — they are constructed before the container.
 *--------------------------------------------------------------------------------------------*/

import {
  registerSingleton,
  registerSingletonFactory,
  SyncDescriptor,
} from '@universe-editor/platform'
import { app } from 'electron'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { ILoggerService, createNamedLogger } from '@universe-editor/platform'
import { IFileService } from '@universe-editor/platform'
import { IFileSearchService } from '@universe-editor/platform'
import { ISecretStorageService } from '@universe-editor/platform'
import { IMainStorageService } from '../storage.js'
import { IEnvironmentMainService } from '../environment/environmentMainService.js'
import { getAppVersion } from '../appVersion.js'
import { ITextSearchMainService } from '@universe-editor/platform'
import {
  IDisposableLeakService,
  IDiagnosticsService,
  IExchangeRateService,
  IIssueReporterService,
  IPerformanceMarksService,
  IPingService,
  IUsageService,
} from '../../shared/ipc/services.js'
import { IAcpHostService } from '../../shared/ipc/acpHostService.js'
import { IExtensionHostService } from '../../shared/ipc/extensionHostService.js'
import { IExtensionManagementService } from '../../shared/ipc/extensionManagementService.js'
import { IExtensionGalleryService } from '../../shared/ipc/extensionGalleryService.js'
import { IAcpTerminalService } from '../../shared/ipc/acpTerminalService.js'
import { IClaudeBinaryService } from '../../shared/ipc/claudeBinaryService.js'
import { IClaudeConfigService } from '../../shared/ipc/claudeConfigService.js'
import { ICodexBinaryService } from '../../shared/ipc/codexBinaryService.js'
import { ICodexConfigService } from '../../shared/ipc/codexConfigService.js'
import { IUpdateService } from '../../shared/ipc/updateService.js'
import { IReleaseNotesService } from '../../shared/ipc/releaseNotesService.js'
import { IDocsService } from '../../shared/ipc/docsService.js'
import { ISessionSwitcherService } from '../../shared/ipc/sessionSwitcher.js'
import { IConfigLocationService } from '../../shared/ipc/configLocationService.js'
import { IAiModelMainService } from '../../shared/ipc/aiModelService.js'
import { IAiDebugService } from '../../shared/ipc/aiDebugService.js'
import { IRemoteSchemaService } from '../../shared/ipc/remoteSchemaService.js'
import {
  IRemoteStatusService,
  REMOTE_CONNECTION_LOG_CHANNEL_NAME,
} from '../../shared/ipc/remoteStatusService.js'
import { IResourceAccessService } from '../../shared/ipc/resourceAccessService.js'
import { IEnvironmentSnapshotService } from '../../shared/ipc/environmentSnapshotService.js'
import { MainPingService } from './ping/pingMainService.js'
import { FileSystemMainService } from './files/fileSystemMainService.js'
import { FileSearchMainService } from './fileSearch/fileSearchMainService.js'
import { TextSearchMainService } from './textSearch/textSearchMainService.js'
import {
  IRecentWorkspacesService,
  RecentWorkspacesMainService,
} from './workspace/recentWorkspacesMainService.js'
import { AcpHostMainService } from './acpHost/acpHostMainService.js'
import { ExtensionHostMainService } from './extensionHost/extensionHostMainService.js'
import { RemoteExtensionHostService } from './extensionHost/remoteExtensionHostService.js'
import { createTsServerSpecResolver } from './extensionHost/tsServerPaths.js'
import { normalizeDevExtensionPaths } from './extensionHost/devExtensionsDir.js'
import { ExtensionManagementMainService } from './extensionManagement/extensionManagementService.js'
import { ExtensionGalleryMainService } from './extensionManagement/extensionGalleryService.js'
import { resolveMarketplaceSigningKeys } from './extensionManagement/marketplaceSigningKeys.js'
import { AcpTerminalMainService } from './acpTerminal/acpTerminalMainService.js'
import { ClaudeBinaryMainService } from './claudeBinary/claudeBinaryMainService.js'
import { ClaudeConfigMainService } from './claudeConfig/claudeConfigMainService.js'
import { CodexBinaryMainService } from './codexBinary/codexBinaryMainService.js'
import { CodexConfigMainService } from './codexConfig/codexConfigMainService.js'
import { DisposableLeakMainService } from './disposableLeak/disposableLeakMainService.js'
import { UpdateMainService } from './update/updateMainService.js'
import { ReleaseNotesMainService } from './releaseNotes/releaseNotesMainService.js'
import { DocsMainService } from './docs/docsMainService.js'
import { PerformanceMainService } from './performance/performanceMainService.js'
import { SessionSwitcherMainService } from './sessionSwitcher/sessionSwitcherMainService.js'
import { ConfigLocationMainService } from './configLocation/configLocationMainService.js'
import { UsageMainService } from './usage/usageMainService.js'
import { SecretStorageMainService } from './ai/secretStorageMainService.js'
import { AiModelMainService } from './ai/aiModelMainService.js'
import { AiDebugRecorder, IAiDebugRecorderService } from './ai/aiDebugRecorder.js'
import { AiDebugMainService } from './ai/aiDebugService.js'
import { RemoteSchemaMainService } from './remoteSchema/remoteSchemaMainService.js'
import { ExchangeRateMainService } from './exchangeRate/exchangeRateMainService.js'
import { ResourceAccessMainService } from './resourceAccess/resourceAccessMainService.js'
import { EnvironmentSnapshotMainService } from './environmentSnapshot/environmentSnapshotMainService.js'
import { DiagnosticsMainService } from './diagnostics/diagnosticsMainService.js'
import { IssueReporterMainService } from './issueReporter/issueReporterMainService.js'
import { IProcessMonitorService } from '../../shared/ipc/processMonitorService.js'
import { ProcessMonitorMainService } from './processMonitor/processMonitorMainService.js'
import { IWatcherProcessService, WatcherProcessClient } from '@universe-editor/node-services'
import { createWatcherUtilityTransportFactory } from './fileWatcher/watcherUtilityTransport.js'
import {
  IRemoteConnectionService,
  RemoteConnectionMainService,
} from './remote/remoteConnectionMainService.js'
import { RemoteDeployer } from './remote/remoteDeploy.js'
import { RemoteStatusMainService } from './remoteStatus/remoteStatusMainService.js'

// Services whose constructors mix @-injected services with non-branded static
// params (spawner stubs, Storage, filePath) are registered via
// registerSingletonFactory: the factory constructs them explicitly, passing the
// static params (default values via `undefined`) positionally and resolving the
// injected ones through the accessor. This is a type-checked constructor call —
// adding/removing a static param is a compile error, not a runtime console.trace
// from a mismatched `[undefined, ...]` padding count. Pure-injected services
// keep the plain SyncDescriptor form. All eager (the bootstrap resolves them at
// once): supportsDelayedInstantiation defaults to false.
registerSingleton(IPingService, new SyncDescriptor<IPingService>(MainPingService, [], false))
registerSingleton(IFileService, new SyncDescriptor<IFileService>(FileSystemMainService, [], false))
registerSingleton(
  IFileSearchService,
  new SyncDescriptor<IFileSearchService>(FileSearchMainService, [], false),
)
registerSingleton(
  ITextSearchMainService,
  new SyncDescriptor<ITextSearchMainService>(TextSearchMainService, [], false),
)
registerSingleton(
  IRecentWorkspacesService,
  new SyncDescriptor<RecentWorkspacesMainService>(RecentWorkspacesMainService, [], false),
)
registerSingletonFactory(
  IAcpHostService,
  (acc) =>
    new AcpHostMainService(
      undefined,
      undefined,
      undefined,
      acc.get(ILoggerService),
      acc.get(IRemoteConnectionService),
    ),
)
registerSingletonFactory(
  IAcpTerminalService,
  (acc) =>
    new AcpTerminalMainService(
      undefined,
      acc.get(ILoggerService),
      acc.get(IRemoteConnectionService),
    ),
)
registerSingletonFactory(
  IExtensionHostService,
  (acc) =>
    new ExtensionHostMainService(
      undefined,
      undefined,
      undefined,
      undefined,
      createTsServerSpecResolver(
        acc.get(IEnvironmentMainService).configDir,
        // Same channel as ExtensionHostMainService's logger — the per-spawn
        // tsServer line lands in the "Extension Host" output channel.
        createNamedLogger(acc.get(ILoggerService), { id: 'extensionHost', name: 'Extension Host' }),
      ),
      () => normalizeDevExtensionPaths(acc.get(IEnvironmentMainService).extensionDevPaths),
      () => ({
        port: acc.get(IEnvironmentMainService).inspectExtensionsPort,
        brk: acc.get(IEnvironmentMainService).inspectBrkExtensionsPort,
      }),
      acc.get(ILoggerService),
      new RemoteExtensionHostService(acc.get(IRemoteConnectionService), acc.get(ILoggerService)),
    ),
)
registerSingletonFactory(
  IExtensionGalleryService,
  (acc) =>
    new ExtensionGalleryMainService(
      acc.get(IEnvironmentMainService),
      undefined,
      acc.get(ILoggerService),
    ),
)
registerSingletonFactory(
  IExtensionManagementService,
  (acc) =>
    new ExtensionManagementMainService(
      undefined,
      getAppVersion(),
      acc.get(IExtensionGalleryService),
      acc.get(ILoggerService),
      undefined,
      () => normalizeDevExtensionPaths(acc.get(IEnvironmentMainService).extensionDevPaths),
      resolveMarketplaceSigningKeys(acc.get(IEnvironmentMainService).gallerySigningKeys),
    ),
)
registerSingleton(
  IClaudeBinaryService,
  new SyncDescriptor<IClaudeBinaryService>(ClaudeBinaryMainService, [], false),
)
registerSingletonFactory(
  IClaudeConfigService,
  (acc) =>
    new ClaudeConfigMainService(
      undefined,
      acc.get(ILoggerService),
      acc.get(IConfigLocationService),
      acc.get(IRemoteConnectionService),
    ),
)
registerSingleton(
  ICodexBinaryService,
  new SyncDescriptor<ICodexBinaryService>(CodexBinaryMainService, [], false),
)
registerSingletonFactory(
  ICodexConfigService,
  (acc) =>
    new CodexConfigMainService(
      undefined,
      acc.get(ILoggerService),
      acc.get(IConfigLocationService),
      acc.get(IRemoteConnectionService),
    ),
)
registerSingleton(
  IDisposableLeakService,
  new SyncDescriptor<IDisposableLeakService>(DisposableLeakMainService, [], false),
)
registerSingleton(IUpdateService, new SyncDescriptor<IUpdateService>(UpdateMainService, [], false))
registerSingletonFactory(
  IReleaseNotesService,
  (acc) => new ReleaseNotesMainService(undefined, acc.get(ILoggerService)),
)
registerSingletonFactory(
  IDocsService,
  (acc) => new DocsMainService(undefined, acc.get(ILoggerService)),
)
registerSingletonFactory(
  IPerformanceMarksService,
  (acc) => new PerformanceMainService(acc.get(IMainStorageService), acc.get(ILoggerService)),
)
registerSingleton(
  ISessionSwitcherService,
  new SyncDescriptor<ISessionSwitcherService>(SessionSwitcherMainService, [], false),
)
registerSingleton(
  IConfigLocationService,
  new SyncDescriptor<IConfigLocationService>(ConfigLocationMainService, [], false),
)
registerSingletonFactory(
  IUsageService,
  (acc) =>
    new UsageMainService(undefined, acc.get(ILoggerService), acc.get(IRemoteConnectionService)),
)
registerSingletonFactory(
  ISecretStorageService,
  (acc) =>
    new SecretStorageMainService(undefined, acc.get(IMainStorageService), acc.get(ILoggerService)),
)
registerSingleton(IAiDebugRecorderService, new SyncDescriptor(AiDebugRecorder, [], false))
registerSingleton(
  IAiModelMainService,
  new SyncDescriptor<IAiModelMainService>(AiModelMainService, [], false),
)
registerSingleton(
  IAiDebugService,
  new SyncDescriptor<IAiDebugService>(AiDebugMainService, [], false),
)
registerSingletonFactory(
  IRemoteSchemaService,
  (acc) => new RemoteSchemaMainService(undefined, acc.get(ILoggerService)),
)
registerSingletonFactory(
  IExchangeRateService,
  (acc) => new ExchangeRateMainService(undefined, acc.get(ILoggerService)),
)
registerSingleton(
  IResourceAccessService,
  new SyncDescriptor<IResourceAccessService>(ResourceAccessMainService, [], false),
)
registerSingleton(
  IEnvironmentSnapshotService,
  new SyncDescriptor<IEnvironmentSnapshotService>(EnvironmentSnapshotMainService, [], false),
)
registerSingletonFactory(IDiagnosticsService, (acc) => {
  const extensionManagement = acc.get(IExtensionManagementService)
  const processMonitor = acc.get(IProcessMonitorService)
  return new DiagnosticsMainService(
    {
      crashDumpsDir: app.getPath('crashDumps'),
      logRoot: join(app.getPath('userData'), 'logs'),
      diagnosticsDir: join(app.getPath('userData'), 'diagnostics'),
      mode: process.env['UNIVERSE_E2E'] === '1' ? 'e2e' : app.isPackaged ? 'release' : 'dev',
      revealInShell: process.env['UNIVERSE_E2E'] !== '1',
      collectProcesses: () => processMonitor.formatProcessList(),
      listExtensions: async () => {
        const [installed, builtin] = await Promise.all([
          extensionManagement.getInstalled(),
          extensionManagement.listBuiltinExtensions(),
        ])
        return [...installed, ...builtin].map((e) => ({
          id: e.identifier,
          version: e.version,
          source: e.source,
        }))
      },
    },
    acc.get(ILoggerService),
  )
})
registerSingletonFactory(IProcessMonitorService, (acc) => {
  return new ProcessMonitorMainService(undefined, undefined, acc.get(ILoggerService))
})
registerSingletonFactory(IIssueReporterService, (acc) => {
  const diagnostics = acc.get(IDiagnosticsService)
  return new IssueReporterMainService(
    { createDiagnosticsZip: () => diagnostics.createDiagnosticsZip() },
    acc.get(ILoggerService),
  )
})
registerSingletonFactory(IWatcherProcessService, (acc) => {
  const loggerService = acc.get(ILoggerService)
  const logger = createNamedLogger(loggerService, { id: 'fileWatcher', name: 'File Watcher' })
  // watcherHost.js is its own electron-vite main input, emitted next to index.js.
  const entryPath = fileURLToPath(new URL('./watcherHost.js', import.meta.url))
  return new WatcherProcessClient(
    createWatcherUtilityTransportFactory(entryPath, logger),
    loggerService,
  )
})
registerSingletonFactory(IRemoteConnectionService, (acc) => {
  const loggerService = acc.get(ILoggerService)
  const logger = createNamedLogger(loggerService, {
    id: 'remoteConnection',
    name: REMOTE_CONNECTION_LOG_CHANNEL_NAME,
  })
  const remoteServerCmd = acc.get(IEnvironmentMainService).remoteServerCmd
  const remoteSkipDeployCheck = acc.get(IEnvironmentMainService).remoteSkipDeployCheck
  // Packaged apps deploy from resources/remote-server (staged by runtime-resources),
  // not a workspace checkout; the version must match getAppVersion() so the
  // remote daemon doesn't report a mismatch and force-redeploy every connect.
  const deployerOptions = app.isPackaged
    ? {
        bundleDir: join(process.resourcesPath, 'remote-server'),
        serverVersion: process.env['UNIVERSE_REMOTE_SERVER_VERSION'] ?? getAppVersion(),
      }
    : {}
  return new RemoteConnectionMainService(
    {
      ...(remoteServerCmd !== undefined ? { remoteServerCmd } : {}),
      skipDeployCheck: remoteSkipDeployCheck,
      deployer: new RemoteDeployer({ logger, ...deployerOptions }),
      deployerOptions,
      getUserDataDir: () => app.getPath('userData'),
    },
    loggerService,
  )
})
registerSingleton(
  IRemoteStatusService,
  new SyncDescriptor<IRemoteStatusService>(RemoteStatusMainService, [], false),
)
