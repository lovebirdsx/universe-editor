/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Main-process workspace state manager. Holds current folder + recent list,
 *  persists recents via IStorageService, and exposes wire methods to the
 *  renderer through ProxyChannel.
 *--------------------------------------------------------------------------------------------*/

import { basename } from 'node:path'
import {
  Emitter,
  type Event,
  type IDisposable,
  type ILogger,
  type IRecentWorkspace,
  type IStorageService,
  type IWorkspace,
  type IWorkspaceServiceWire,
  NullLogger,
  URI,
  type UriComponents,
} from '@universe-editor/platform'
import { workspaceIdFromUri } from '../../storage.js'

export interface IFolderDialog {
  showOpenFolderDialog(): Promise<URI | null>
}

/**
 * Storage capability needed by WorkspaceMainService — extends IStorageService
 * with the main-only `switchWorkspace` / `flush` hooks so the service can
 * coordinate scope swaps when the active folder changes.
 */
export interface IWorkspaceScopedStorage extends IStorageService {
  switchWorkspace(workspaceId: string | null): Promise<void>
  flush(): Promise<void>
}

export const RECENT_WORKSPACES_STORAGE_KEY = 'workbench.recentWorkspaces'
export const CURRENT_WORKSPACE_STORAGE_KEY = 'workbench.currentWorkspace'
const MAX_RECENT = 20

interface PersistedRecent {
  readonly folder: UriComponents
  readonly name: string
  readonly lastOpened: number
}

interface PersistedCurrent {
  readonly folder: UriComponents
  readonly name: string
}

function makeWorkspace(folder: URI): IWorkspace {
  return { folder, name: basename(folder.fsPath) || folder.fsPath }
}

function reviveUri(value: URI | UriComponents): URI {
  if (value instanceof URI) return value
  return URI.revive(value) as URI
}

export class WorkspaceMainService implements IWorkspaceServiceWire, IDisposable {
  declare readonly _serviceBrand: undefined

  private readonly _onDidChangeWorkspace = new Emitter<IWorkspace | null>()
  readonly onDidChangeWorkspace: Event<IWorkspace | null> = this._onDidChangeWorkspace.event

  private readonly _onDidChangeRecent = new Emitter<readonly IRecentWorkspace[]>()
  readonly onDidChangeRecent: Event<readonly IRecentWorkspace[]> = this._onDidChangeRecent.event

  private _current: IWorkspace | null = null
  private _recent: IRecentWorkspace[] = []
  private _hydrated = false
  private _hydratePromise: Promise<void> | null = null

  constructor(
    private readonly _storage: IWorkspaceScopedStorage,
    private readonly _folderDialog: IFolderDialog,
    private readonly _logger: ILogger = new NullLogger(),
  ) {}

  private async _hydrate(): Promise<void> {
    if (this._hydrated) return
    if (this._hydratePromise) return this._hydratePromise
    this._hydratePromise = (async () => {
      const raw = await this._storage.get<PersistedRecent[]>(RECENT_WORKSPACES_STORAGE_KEY)
      if (Array.isArray(raw)) {
        this._recent = raw
          .map((r) => {
            const folder = URI.revive(r.folder)
            if (!folder) return null
            return { folder, name: r.name, lastOpened: r.lastOpened }
          })
          .filter((r): r is IRecentWorkspace => r !== null)
          .sort((a, b) => b.lastOpened - a.lastOpened)
          .slice(0, MAX_RECENT)
      }
      const persistedCurrent = await this._storage.get<PersistedCurrent>(
        CURRENT_WORKSPACE_STORAGE_KEY,
      )
      if (persistedCurrent && persistedCurrent.folder) {
        const folder = URI.revive(persistedCurrent.folder)
        if (folder) {
          this._current = { folder, name: persistedCurrent.name }
        }
      }
      // Bind the WORKSPACE-scope backend to the hydrated current workspace
      // (or detach if none), so the first WORKSPACE reads after startup hit
      // the right file.
      try {
        await this._storage.switchWorkspace(
          this._current ? workspaceIdFromUri(this._current.folder.toString()) : null,
        )
      } catch {
        // best-effort; storage layer logs its own errors
      }
      this._logger.debug(
        `hydrate workspace current=${this._current?.folder.toString() ?? '<none>'} recent=${this._recent.length}`,
      )
      this._hydrated = true
    })()
    return this._hydratePromise
  }

  async getCurrent(): Promise<IWorkspace | null> {
    await this._hydrate()
    return this._current
  }

  async getRecent(): Promise<readonly IRecentWorkspace[]> {
    await this._hydrate()
    return this._recent
  }

  async openFolder(folder?: URI | UriComponents): Promise<void> {
    let resolved: URI | null
    // JSON.stringify([undefined]) → "[null]" over IPC, so treat null same as undefined.
    if (folder == null) {
      resolved = await this._folderDialog.showOpenFolderDialog()
      if (!resolved) {
        this._logger.info('openFolder cancelled')
        return
      }
    } else {
      resolved = reviveUri(folder)
    }
    await this._hydrate()
    const workspace = makeWorkspace(resolved)
    // Flush + swap storage scope BEFORE firing onDidChangeWorkspace so
    // subscribers (renderer-side restore contributions) read the new
    // workspace's data, not the previous one's.
    await this._storage.flush()
    await this._storage.switchWorkspace(workspaceIdFromUri(workspace.folder.toString()))
    this._current = workspace
    this._onDidChangeWorkspace.fire(workspace)
    this._addRecent(workspace)
    void this._persistCurrent()
    this._logger.info(`openFolder ${workspace.folder.toString()}`)
  }

  async closeFolder(): Promise<void> {
    if (this._current === null) return
    const previous = this._current.folder.toString()
    await this._storage.flush()
    await this._storage.switchWorkspace(null)
    this._current = null
    this._onDidChangeWorkspace.fire(null)
    void this._persistCurrent()
    this._logger.info(`closeFolder ${previous}`)
  }

  async clearRecent(): Promise<void> {
    await this._hydrate()
    this._recent = []
    this._onDidChangeRecent.fire(this._recent)
    await this._persist()
    this._logger.info('clearRecent')
  }

  /** Internal restore path used when reviving from storage at startup. */
  async restoreCurrent(workspace: IWorkspace): Promise<void> {
    await this._storage.switchWorkspace(workspaceIdFromUri(workspace.folder.toString()))
    this._current = workspace
    this._onDidChangeWorkspace.fire(workspace)
    this._logger.info(`restoreCurrent ${workspace.folder.toString()}`)
  }

  private _addRecent(workspace: IWorkspace): void {
    const folderStr = workspace.folder.toString()
    const filtered = this._recent.filter((r) => r.folder.toString() !== folderStr)
    const entry: IRecentWorkspace = {
      folder: workspace.folder,
      name: workspace.name,
      lastOpened: Date.now(),
    }
    this._recent = [entry, ...filtered].slice(0, MAX_RECENT)
    this._onDidChangeRecent.fire(this._recent)
    void this._persist()
    this._logger.debug(`recentWorkspaces count=${this._recent.length}`)
  }

  private async _persist(): Promise<void> {
    const serialised: PersistedRecent[] = this._recent.map((r) => ({
      folder: r.folder.toJSON(),
      name: r.name,
      lastOpened: r.lastOpened,
    }))
    await this._storage.set(RECENT_WORKSPACES_STORAGE_KEY, serialised)
  }

  private async _persistCurrent(): Promise<void> {
    if (this._current === null) {
      await this._storage.set(CURRENT_WORKSPACE_STORAGE_KEY, null)
      return
    }
    const serialised: PersistedCurrent = {
      folder: this._current.folder.toJSON(),
      name: this._current.name,
    }
    await this._storage.set(CURRENT_WORKSPACE_STORAGE_KEY, serialised)
  }

  dispose(): void {
    this._onDidChangeWorkspace.dispose()
    this._onDidChangeRecent.dispose()
  }
}
