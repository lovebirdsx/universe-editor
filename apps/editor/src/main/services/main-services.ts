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
import { ILoggerService, createNamedLogger } from '@universe-editor/platform'
import { IFileService } from '@universe-editor/platform'
import { IFileSearchService } from '@universe-editor/platform'
import { ISecretStorageService } from '@universe-editor/platform'
import { IMainStorageService } from '../storage.js'
import { IEnvironmentMainService } from '../environment/environmentMainService.js'
import { ITextSearchMainService } from '../../shared/ipc/textSearchService.js'
import {
  IDisposableLeakService,
  IExchangeRateService,
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
import { createTsServerSpecResolver } from './extensionHost/tsServerPaths.js'
import { ExtensionManagementMainService } from './extensionManagement/extensionManagementService.js'
import { ExtensionGalleryMainService } from './extensionManagement/extensionGalleryService.js'
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
  (acc) => new AcpHostMainService(undefined, undefined, undefined, acc.get(ILoggerService)),
)
registerSingletonFactory(
  IAcpTerminalService,
  (acc) => new AcpTerminalMainService(undefined, acc.get(ILoggerService)),
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
      acc.get(ILoggerService),
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
      undefined,
      acc.get(IExtensionGalleryService),
      acc.get(ILoggerService),
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
    ),
)
registerSingleton(
  ICodexBinaryService,
  new SyncDescriptor<ICodexBinaryService>(CodexBinaryMainService, [], false),
)
registerSingletonFactory(
  ICodexConfigService,
  (acc) =>
    new CodexConfigMainService(undefined, acc.get(ILoggerService), acc.get(IConfigLocationService)),
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
  (acc) => new UsageMainService(undefined, acc.get(ILoggerService)),
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
