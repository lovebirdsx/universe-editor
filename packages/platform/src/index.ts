/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Public API surface for @universe-editor/platform.
 *--------------------------------------------------------------------------------------------*/

// base utilities
export * from './base/event.js'
export * from './base/lifecycle.js'
export * from './base/linkedList.js'
export * from './base/functional.js'
export * from './base/observable/index.js'

// dependency injection
export * from './di/instantiation.js'
export * from './di/descriptors.js'
export * from './di/serviceCollection.js'
export * from './di/graph.js'
export * from './di/instantiationService.js'

// logging
export * from './log/log.js'

// application lifecycle phases
export * from './lifecycle/lifecycleService.js'

// commands, keybindings, menus, context keys
export * from './command/commandRegistry.js'
export * from './command/menuRegistry.js'
export * from './command/keybindingRegistry.js'
export * from './command/contextKey.js'

// workbench contributions
export * from './contribution/contribution.js'

// configuration system
export * from './configuration/configurationRegistry.js'
export * from './configuration/configurationService.js'

// IPC abstraction layer
export * from './ipc/ipc.js'

// host abstraction (window / OS)
export * from './host/index.js'

// workbench service interfaces
export * from './workbench/layoutService.js'
export * from './workbench/viewRegistry.js'
export * from './workbench/viewsService.js'
export * from './workbench/editorService.js'
export * from './workbench/statusbarService.js'
export * from './workbench/quickInputService.js'
export * from './workbench/outputService.js'
export * from './workbench/storageService.js'
