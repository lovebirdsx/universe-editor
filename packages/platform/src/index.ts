/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Public API surface for @universe-editor/platform.
 *
 *  This root barrel only re-exports each subdirectory's `index.ts`. When adding a
 *  new module, add a single line to the barrel of the directory it lives in — not
 *  here. The `index.test.ts` coverage check guards against files that export
 *  symbols but are never reached from any barrel.
 *--------------------------------------------------------------------------------------------*/

export * from './glob/index.js'
export * from './base/index.js'
export * from './di/index.js'
export * from './log/index.js'
export * from './nls/index.js'
export * from './lifecycle/index.js'
export * from './command/index.js'
export * from './contribution/index.js'
export * from './configuration/index.js'
export * from './ipc/index.js'
export * from './host/index.js'
export * from './window/index.js'
export * from './storage/index.js'
export * from './userdata/index.js'
export * from './files/index.js'
export * from './dialog/index.js'
export * from './notification/index.js'
export * from './progress/index.js'
export * from './workspace/index.js'
export * from './workbench/index.js'
export * from './telemetry/index.js'
export * from './ai/index.js'
export * from './secret/index.js'
