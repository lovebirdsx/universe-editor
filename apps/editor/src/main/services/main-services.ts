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

import { registerSingleton, SyncDescriptor } from '@universe-editor/platform'
import { IFileService } from '@universe-editor/platform'
import { IFileSearchService } from '@universe-editor/platform'
import { ISecretStorageService } from '@universe-editor/platform'
import { ITextSearchMainService } from '../../shared/ipc/textSearchService.js'
import {
  IDisposableLeakService,
  IPerformanceMarksService,
  IPingService,
  IUsageService,
} from '../../shared/ipc/services.js'
import { IAcpHostService } from '../../shared/ipc/acpHostService.js'
import { IExtensionHostService } from '../../shared/ipc/extensionHostService.js'
import { IAcpTerminalService } from '../../shared/ipc/acpTerminalService.js'
import { IClaudeBinaryService } from '../../shared/ipc/claudeBinaryService.js'
import { IClaudeConfigService } from '../../shared/ipc/claudeConfigService.js'
import { ICodexBinaryService } from '../../shared/ipc/codexBinaryService.js'
import { ICodexConfigService } from '../../shared/ipc/codexConfigService.js'
import { IUpdateService } from '../../shared/ipc/updateService.js'
import { IReleaseNotesService } from '../../shared/ipc/releaseNotesService.js'
import { ISessionSwitcherService } from '../../shared/ipc/sessionSwitcher.js'
import { IConfigLocationService } from '../../shared/ipc/configLocationService.js'
import { IAiModelMainService } from '../../shared/ipc/aiModelService.js'
import { IAiDebugService } from '../../shared/ipc/aiDebugService.js'
import { IRemoteSchemaService } from '../../shared/ipc/remoteSchemaService.js'
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
import { AcpTerminalMainService } from './acpTerminal/acpTerminalMainService.js'
import { ClaudeBinaryMainService } from './claudeBinary/claudeBinaryMainService.js'
import { ClaudeConfigMainService } from './claudeConfig/claudeConfigMainService.js'
import { CodexBinaryMainService } from './codexBinary/codexBinaryMainService.js'
import { CodexConfigMainService } from './codexConfig/codexConfigMainService.js'
import { DisposableLeakMainService } from './disposableLeak/disposableLeakMainService.js'
import { UpdateMainService } from './update/updateMainService.js'
import { ReleaseNotesMainService } from './releaseNotes/releaseNotesMainService.js'
import { PerformanceMainService } from './performance/performanceMainService.js'
import { SessionSwitcherMainService } from './sessionSwitcher/sessionSwitcherMainService.js'
import { ConfigLocationMainService } from './configLocation/configLocationMainService.js'
import { UsageMainService } from './usage/usageMainService.js'
import { SecretStorageMainService } from './ai/secretStorageMainService.js'
import { AiModelMainService } from './ai/aiModelMainService.js'
import { AiDebugRecorder, IAiDebugRecorderService } from './ai/aiDebugRecorder.js'
import { AiDebugMainService } from './ai/aiDebugService.js'
import { RemoteSchemaMainService } from './remoteSchema/remoteSchemaMainService.js'

// SyncDescriptor (not the ctor overload) because these constructors mix
// @-injected services with non-branded static params (spawner stubs, Storage,
// IUpdateEnvironment, filePath) that carry default values. When a constructor has
// leading static params BEFORE its @-injected ones (AcpHost, AcpTerminal), the
// staticArguments must pad those slots with `undefined` so their count matches the
// first service-arg position — otherwise the kernel logs a console.trace and pads
// itself. `undefined` makes each default value kick in. All eager
// (supportsDelayedInstantiation=false): bootstrap resolves them at once.
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
registerSingleton(
  IAcpHostService,
  // 3 leading static params (spawn, lookup, resolveNodeEntry) before @ILoggerService.
  new SyncDescriptor<IAcpHostService>(AcpHostMainService, [undefined, undefined, undefined], false),
)
registerSingleton(
  IAcpTerminalService,
  // 1 leading static param (spawn) before @ILoggerService.
  new SyncDescriptor<IAcpTerminalService>(AcpTerminalMainService, [undefined], false),
)
registerSingleton(
  IExtensionHostService,
  // 5 leading static params (spawn, resolveEntry, resolveExtensionsDir,
  // resolveUserExtensionsDir, resolveTsServerPaths) before @ILoggerService.
  new SyncDescriptor<IExtensionHostService>(
    ExtensionHostMainService,
    [undefined, undefined, undefined, undefined, undefined],
    false,
  ),
)
registerSingleton(
  IClaudeBinaryService,
  new SyncDescriptor<IClaudeBinaryService>(ClaudeBinaryMainService, [], false),
)
registerSingleton(
  IClaudeConfigService,
  // 1 leading static param (settingsPath) before @ILoggerService.
  new SyncDescriptor<IClaudeConfigService>(ClaudeConfigMainService, [undefined], false),
)
registerSingleton(
  ICodexBinaryService,
  new SyncDescriptor<ICodexBinaryService>(CodexBinaryMainService, [], false),
)
registerSingleton(
  ICodexConfigService,
  // 1 leading static param (configPath) before @ILoggerService.
  new SyncDescriptor<ICodexConfigService>(CodexConfigMainService, [undefined], false),
)
registerSingleton(
  IDisposableLeakService,
  new SyncDescriptor<IDisposableLeakService>(DisposableLeakMainService, [], false),
)
registerSingleton(IUpdateService, new SyncDescriptor<IUpdateService>(UpdateMainService, [], false))
registerSingleton(
  IReleaseNotesService,
  // 1 leading static param (resolvePath) before @ILoggerService.
  new SyncDescriptor<IReleaseNotesService>(ReleaseNotesMainService, [undefined], false),
)
registerSingleton(
  IPerformanceMarksService,
  new SyncDescriptor<IPerformanceMarksService>(PerformanceMainService, [], false),
)
registerSingleton(
  ISessionSwitcherService,
  new SyncDescriptor<ISessionSwitcherService>(SessionSwitcherMainService, [], false),
)
registerSingleton(
  IConfigLocationService,
  new SyncDescriptor<IConfigLocationService>(ConfigLocationMainService, [], false),
)
registerSingleton(
  IUsageService,
  // 1 leading static param (settingsPath) before @ILoggerService.
  new SyncDescriptor<IUsageService>(UsageMainService, [undefined], false),
)
registerSingleton(
  ISecretStorageService,
  // 1 leading static param (safeStorage) before @IMainStorageService / @ILoggerService.
  new SyncDescriptor<ISecretStorageService>(SecretStorageMainService, [undefined], false),
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
registerSingleton(
  IRemoteSchemaService,
  // 1 leading static param (cacheDir) before @ILoggerService.
  new SyncDescriptor<IRemoteSchemaService>(RemoteSchemaMainService, [undefined], false),
)
