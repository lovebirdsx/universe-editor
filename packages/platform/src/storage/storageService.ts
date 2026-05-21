/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Renderer-facing key-value storage service. Implementations bridge to host storage.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../base/event.js'
import { createDecorator } from '../di/instantiation.js'

/**
 * Scope under which a storage key is persisted.
 *  - GLOBAL: shared across all workspaces (default — backwards-compatible).
 *  - WORKSPACE: tied to the currently open workspace; reads/writes route to a
 *    per-workspace backend and reset when the workspace changes.
 */
export enum StorageScope {
  GLOBAL = 0,
  WORKSPACE = 1,
}

export interface IStorageService {
  readonly _serviceBrand: undefined
  get<T = unknown>(key: string, scope?: StorageScope): Promise<T | undefined>
  set(key: string, value: unknown, scope?: StorageScope): Promise<void>
  remove(key: string, scope?: StorageScope): Promise<void>
  /** Fires after the WORKSPACE-scope backend has switched (workspace open/close/change). */
  readonly onDidChangeWorkspaceScope: Event<void>
}

export const IStorageService = createDecorator<IStorageService>('storageService')
