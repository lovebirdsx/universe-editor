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
import { canonicalizeWorkspaceFolderUri } from '../remote/remoteUri.js'

export const RECENT_WORKSPACES_STORAGE_KEY = 'workbench.recentWorkspaces'

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
        const revived = raw
          .map((r) => {
            const folder = URI.revive(r.folder)
            if (!folder) return null
            return {
              folder: canonicalizeWorkspaceFolderUri(folder),
              name: r.name,
              lastOpened: r.lastOpened,
            }
          })
          .filter((r): r is IRecentWorkspace => r !== null)
          .sort((a, b) => b.lastOpened - a.lastOpened)
        // A build that spelled a folder two ways could store it twice; the list
        // is newest-first by now, so the first occurrence is the one to keep.
        const seen = new Set<string>()
        this._recent = revived.filter((r) => {
          const key = r.folder.toString()
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
        if (this._recent.length !== raw.length) await this._persist()
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
    const folder = canonicalizeWorkspaceFolderUri(workspace.folder)
    const folderStr = folder.toString()
    const filtered = this._recent.filter((r) => r.folder.toString() !== folderStr)
    const entry: IRecentWorkspace = {
      folder,
      name: workspace.name,
      lastOpened: Date.now(),
    }
    this._recent = [entry, ...filtered]
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
    if (!revived) return
    const folderStr = canonicalizeWorkspaceFolderUri(revived).toString()
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
