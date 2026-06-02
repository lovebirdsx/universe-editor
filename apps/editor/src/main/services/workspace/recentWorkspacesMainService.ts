/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Application-singleton recent-workspaces list. Shared across all windows
 *  (VSCode keeps the recent list global), persisted to the GLOBAL state.json.
 *  Per-window WorkspaceMainService instances delegate recent reads/mutations
 *  here and relay its change event to their renderer.
 *--------------------------------------------------------------------------------------------*/

import {
  createDecorator,
  createNamedLogger,
  Emitter,
  type Event,
  type IDisposable,
  type ILogger,
  ILoggerService,
  type IRecentWorkspace,
  type IWorkspace,
  URI,
  type UriComponents,
} from '@universe-editor/platform'
import { IMainStorageService, type Storage } from '../../storage.js'

export const RECENT_WORKSPACES_STORAGE_KEY = 'workbench.recentWorkspaces'
const MAX_RECENT = 20

interface PersistedRecent {
  readonly folder: UriComponents
  readonly name: string
  readonly lastOpened: number
}

export const IRecentWorkspacesService =
  createDecorator<RecentWorkspacesMainService>('recentWorkspacesService')

export class RecentWorkspacesMainService implements IDisposable {
  private readonly _onDidChangeRecent = new Emitter<readonly IRecentWorkspace[]>()
  readonly onDidChangeRecent: Event<readonly IRecentWorkspace[]> = this._onDidChangeRecent.event

  private _recent: IRecentWorkspace[] = []
  private _hydrated = false
  private _hydratePromise: Promise<void> | null = null
  private readonly _logger: ILogger

  constructor(
    @IMainStorageService private readonly _storage: Storage,
    @ILoggerService loggerService?: ILoggerService,
  ) {
    this._logger = createNamedLogger(loggerService, { id: 'workspace', name: 'Workspace' })
  }

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
      this._hydrated = true
      this._logger.debug(`hydrate recentWorkspaces count=${this._recent.length}`)
    })()
    return this._hydratePromise
  }

  async getRecent(): Promise<readonly IRecentWorkspace[]> {
    await this._hydrate()
    return this._recent
  }

  async add(workspace: IWorkspace): Promise<void> {
    await this._hydrate()
    const folderStr = workspace.folder.toString()
    const filtered = this._recent.filter((r) => r.folder.toString() !== folderStr)
    const entry: IRecentWorkspace = {
      folder: workspace.folder,
      name: workspace.name,
      lastOpened: Date.now(),
    }
    this._recent = [entry, ...filtered].slice(0, MAX_RECENT)
    this._onDidChangeRecent.fire(this._recent)
    await this._persist()
    this._logger.debug(`recentWorkspaces count=${this._recent.length}`)
  }

  async clear(): Promise<void> {
    await this._hydrate()
    this._recent = []
    this._onDidChangeRecent.fire(this._recent)
    await this._persist()
    this._logger.info('clearRecent')
  }

  async remove(folder: UriComponents | URI): Promise<void> {
    await this._hydrate()
    const revived = folder instanceof URI ? folder : URI.revive(folder)
    const folderStr = revived?.toString()
    if (!folderStr) return
    const next = this._recent.filter((r) => r.folder.toString() !== folderStr)
    if (next.length === this._recent.length) return
    this._recent = next
    this._onDidChangeRecent.fire(this._recent)
    await this._persist()
    this._logger.debug(`removeRecent count=${this._recent.length}`)
  }

  private async _persist(): Promise<void> {
    const serialised: PersistedRecent[] = this._recent.map((r) => ({
      folder: r.folder.toJSON(),
      name: r.name,
      lastOpened: r.lastOpened,
    }))
    await this._storage.set(RECENT_WORKSPACES_STORAGE_KEY, serialised)
  }

  dispose(): void {
    this._onDidChangeRecent.dispose()
  }
}
