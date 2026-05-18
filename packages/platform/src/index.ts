/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Public API surface for @universe-editor/platform.
 *--------------------------------------------------------------------------------------------*/

// base utilities
export * from './base/event.js'
export * from './base/lifecycle.js'
export * from './base/linkedList.js'
export * from './base/functional.js'
export * from './base/async.js'
export * from './base/uri.js'
export * from './base/grid.js'
export * from './base/observable/index.js'

// dependency injection
export * from './di/instantiation.js'
export * from './di/descriptors.js'
export * from './di/serviceCollection.js'
export * from './di/graph.js'
export * from './di/instantiationService.js'

// logging
export * from './log/log.js'

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

// IPC abstraction layer
export * from './ipc/ipc.js'
export * from './ipc/proxyChannel.js'

// host abstraction (window / OS)
export * from './host/index.js'

// storage abstraction
export * from './storage/storageService.js'

// user data files (settings.json / keybindings.json)
export * from './userdata/userDataFilesService.js'

// filesystem abstraction
export * from './files/fileService.js'
export * from './files/fileWatcher.js'

// modal dialog abstraction
export * from './dialog/dialogService.js'

// workspace state
export * from './workspace/workspaceService.js'

// workbench service interfaces
export * from './workbench/layoutService.js'
export * from './workbench/part.js'
export * from './workbench/viewRegistry.js'
export * from './workbench/viewsService.js'
export * from './workbench/editorService.js'
export * from './workbench/editorGroupModel.js'
export * from './workbench/editorGroupsService.js'
export * from './workbench/statusbarService.js'
export * from './workbench/quickInputService.js'
export * from './workbench/outputService.js'
export * from './workbench/searchService.js'
