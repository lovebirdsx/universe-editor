/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Public API surface for @universe-editor/platform.
 *--------------------------------------------------------------------------------------------*/

// base utilities
export * from './glob/glob.js'
export * from './base/errors.js'
export * from './base/event.js'
export * from './base/lifecycle.js'
export * from './base/linkedList.js'
export * from './base/functional.js'
export * from './base/async.js'
export * from './base/cancellation.js'
export * from './base/uri.js'
export * from './base/uuid.js'
export * from './base/path.js'
export * from './base/grid.js'
export * from './base/observable/index.js'
export * from './base/performance.js'

// dependency injection
export * from './di/instantiation.js'
export * from './di/descriptors.js'
export * from './di/serviceCollection.js'
export * from './di/graph.js'
export * from './di/instantiationService.js'
export * from './di/extensions.js'

// logging
export * from './log/log.js'
export * from './log/loggerService.js'
export * from './log/consoleInterceptor.js'

// localization
export * from './nls/nls.js'

// application lifecycle phases
export * from './lifecycle/lifecycleService.js'

// commands, keybindings, menus, context keys
export * from './command/commandRegistry.js'
export * from './command/menuRegistry.js'
export * from './command/keybindingRegistry.js'
export * from './command/contextKey.js'
export * from './command/contextKeyExpr.js'
export * from './command/action.js'

// workbench contributions
export * from './contribution/contribution.js'

// configuration system
export * from './configuration/configurationRegistry.js'
export * from './configuration/configurationService.js'
export * from './configuration/jsonSchemaRegistry.js'
// multi-source configuration resolution (cli / env / file)
export * from './configuration/sources/configSource.js'
export * from './configuration/sources/cliConfigSource.js'
export * from './configuration/sources/envConfigSource.js'
export * from './configuration/sources/fileConfigSource.js'
export * from './configuration/sources/configValidators.js'
export * from './configuration/sources/cliHelp.js'

// IPC abstraction layer
export * from './ipc/ipc.js'
export * from './ipc/proxyChannel.js'

// host abstraction (window / OS)
export * from './host/index.js'

// application-scoped window orchestration (multi-window)
export * from './window/windowsService.js'

// storage abstraction
export * from './storage/storageService.js'

// user data files (settings.json / keybindings.json)
export * from './userdata/userDataFilesService.js'

// filesystem abstraction
export * from './files/fileService.js'
export * from './files/fileWatcher.js'

// modal dialog abstraction
export * from './dialog/dialogService.js'
export * from './dialog/fileDialogService.js'

// notification service
export * from './notification/notificationService.js'

// progress service (long-running async UI surface)
export * from './progress/progressService.js'

// workspace state
export * from './workspace/workspaceService.js'

// workbench service interfaces
export * from './workbench/layoutService.js'
export * from './workbench/part.js'
export * from './workbench/focusTracker.js'
export * from './workbench/focusableRegistry.js'
export * from './workbench/focusStack.js'
export * from './workbench/historyService.js'
export * from './workbench/viewRegistry.js'
export * from './workbench/viewDescriptorService.js'
export * from './workbench/viewsService.js'
export * from './workbench/editorService.js'
export * from './workbench/editorGroupModel.js'
export * from './workbench/editorGroupsService.js'
export * from './workbench/editorResolverService.js'
export * from './workbench/statusbarService.js'
export * from './workbench/quickInputService.js'
export * from './workbench/quickAccess.js'
export * from './workbench/outputService.js'
export * from './workbench/searchService.js'
export * from './workbench/fileSearchService.js'

// telemetry
export * from './telemetry/telemetryService.js'
export * from './telemetry/noopTelemetryService.js'

// AI model service (contracts + registry + stream reassembly)
export * from './ai/aiModelTypes.js'
export * from './ai/aiDebugTypes.js'
export * from './ai/aiModelConfiguration.js'
export * from './ai/aiModelService.js'
export * from './ai/aiModelProvider.js'
export * from './ai/aiModelRegistry.js'
export * from './ai/aiStream.js'

// encrypted secret storage (interface; implementation in main)
export * from './secret/secretStorageService.js'
