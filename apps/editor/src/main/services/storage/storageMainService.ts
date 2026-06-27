/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Wire-facing storage service. Implements `IStorageService` directly (single-layer
 *  interface shared with the renderer via ProxyChannel).
 *
 *  Scope routing:
 *   - GLOBAL  → single application-wide backend (state.json).
 *   - WORKSPACE → per-workspace backend under workspaces/<id>.json, swapped via
 *     switchWorkspace() when the active folder changes. With no workspace open,
 *     workspace reads return undefined and writes are no-ops.
 *--------------------------------------------------------------------------------------------*/

import {
  Emitter,
  type Event,
  StorageScope,
  type IStorageService,
  URI,
} from '@universe-editor/platform'
import {
  createStorage,
  getDefaultStorage,
  workspaceIdFromUri,
  workspaceStoragePath,
  type Storage,
} from '../../storage.js'

// Workspace-scope keys we know about — used to migrate (purge) legacy global
// entries that pre-date the scope split. Listed here to keep the migration
// closed-form; new workspace keys should be added when introduced.
const LEGACY_WORKSPACE_KEYS = [
  'workbench.workspaceState',
  'workbench.views',
  'workbench.layout',
  'workbench.recentFiles',
]

// The legacy purge mutates the shared GLOBAL backend, so it must run exactly once
// per backend — not once per window. Keyed by backend instance: production windows
// all share getDefaultStorage() (one purge), while each test builds a fresh backend
// (purge runs per test). Subsequent windows await the same promise via whenReady.
const purgePromises = new WeakMap<Storage, Promise<void>>()

export class MainStorageService implements IStorageService {
  declare readonly _serviceBrand: undefined

  private readonly _global: Storage
  private _workspaceId: string | null = null
  private _workspace: Storage | null = null

  private readonly _onDidChangeWorkspaceScope = new Emitter<void>()
  readonly onDidChangeWorkspaceScope: Event<void> = this._onDidChangeWorkspaceScope.event

  /**
   * Resolves once the legacy-key purge started by the constructor completes.
   * Production code does not need to wait — purge is best-effort — but tests
   * use this to make assertions deterministic.
   */
  readonly whenReady: Promise<void>

  constructor(globalStorage: Storage = getDefaultStorage()) {
    this._global = globalStorage
    // Drop legacy workspace-scope keys from the global file the first time we
    // boot after this refactor. Fire-and-forget so startup isn't blocked.
    this.whenReady = this._purgeLegacyWorkspaceKeys()
  }

  async get<T = unknown>(
    key: string,
    scope: StorageScope = StorageScope.GLOBAL,
  ): Promise<T | undefined> {
    if (scope === StorageScope.WORKSPACE) {
      if (!this._workspace) return undefined
      return this._workspace.get<T>(key)
    }
    return this._global.get<T>(key)
  }

  async set(key: string, value: unknown, scope: StorageScope = StorageScope.GLOBAL): Promise<void> {
    if (scope === StorageScope.WORKSPACE) {
      if (!this._workspace) return
      return this._workspace.set(key, value)
    }
    return this._global.set(key, value)
  }

  async remove(key: string, scope: StorageScope = StorageScope.GLOBAL): Promise<void> {
    if (scope === StorageScope.WORKSPACE) {
      if (!this._workspace) return
      return this._workspace.remove(key)
    }
    return this._global.remove(key)
  }

  async getForWorkspaceCwd<T = unknown>(key: string, cwd: string): Promise<T | undefined> {
    const id = workspaceIdFromUri(URI.file(cwd).toString())
    // Hitting the active bucket: go through the live backend so we don't read a
    // stale on-disk copy that predates pending in-memory writes.
    if (id === this._workspaceId && this._workspace) return this._workspace.get<T>(key)
    // Otherwise open a throwaway read-only handle on the target bucket's file.
    return createStorage(workspaceStoragePath(id)).get<T>(key)
  }

  /**
   * Swap the active WORKSPACE-scope backend. Flushes the previous backend's
   * pending writes before releasing it so no data is lost. Pass `null` to
   * detach (no workspace open). Fires `onDidChangeWorkspaceScope` exactly
   * once after the swap completes; callers should treat all WORKSPACE-scope
   * data as invalid until the event resolves.
   *
   * Not part of `IStorageService` — main-only API used by `WorkspaceMainService`.
   */
  async switchWorkspace(workspaceId: string | null): Promise<void> {
    if (workspaceId === this._workspaceId) return
    if (this._workspace) {
      try {
        await this._workspace.flush()
      } catch {
        // best-effort flush; proceed with swap regardless
      }
    }
    this._workspaceId = workspaceId
    this._workspace = workspaceId === null ? null : createStorage(workspaceStoragePath(workspaceId))
    this._onDidChangeWorkspaceScope.fire()
  }

  async flush(): Promise<void> {
    await this._global.flush()
    if (this._workspace) await this._workspace.flush()
  }

  private _purgeLegacyWorkspaceKeys(): Promise<void> {
    const existing = purgePromises.get(this._global)
    if (existing) return existing
    const promise = (async () => {
      try {
        for (const key of LEGACY_WORKSPACE_KEYS) {
          const existingValue = await this._global.get(key)
          if (existingValue !== undefined) {
            await this._global.remove(key)
          }
        }
      } catch {
        // never block startup on migration; stale keys are harmless
      }
    })()
    purgePromises.set(this._global, promise)
    return promise
  }

  dispose(): void {
    this._onDidChangeWorkspaceScope.dispose()
  }
}
