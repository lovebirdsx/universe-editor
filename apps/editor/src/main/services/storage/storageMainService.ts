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

import { Emitter, type Event, StorageScope, type IStorageService } from '@universe-editor/platform'
import {
  createStorage,
  getDefaultStorage,
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

  private async _purgeLegacyWorkspaceKeys(): Promise<void> {
    try {
      for (const key of LEGACY_WORKSPACE_KEYS) {
        const existing = await this._global.get(key)
        if (existing !== undefined) {
          await this._global.remove(key)
        }
      }
    } catch {
      // never block startup on migration; stale keys are harmless
    }
  }

  dispose(): void {
    this._onDidChangeWorkspaceScope.dispose()
  }
}
