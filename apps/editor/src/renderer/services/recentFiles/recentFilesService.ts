import {
  IStorageService,
  StorageScope,
  URI,
  createDecorator,
  type UriComponents,
} from '@universe-editor/platform'

export interface IRecentFile {
  readonly uri: URI
  readonly name: string
  readonly lastOpened: number
}

export interface IRecentFilesService {
  readonly _serviceBrand: undefined
  add(uri: URI, name: string): void
  getAll(): Promise<readonly IRecentFile[]>
  clear(): void
}

export const IRecentFilesService = createDecorator<IRecentFilesService>('recentFilesService')

interface PersistedRecentFile {
  readonly uri: UriComponents
  readonly name: string
  readonly lastOpened: number
}

const STORAGE_KEY = 'workbench.recentFiles'
const MAX_ITEMS = 50

export class RecentFilesService implements IRecentFilesService {
  readonly _serviceBrand: undefined

  private _items: IRecentFile[] = []
  private _loadPromise: Promise<void> | null = null

  constructor(@IStorageService private readonly _storage: IStorageService) {
    this._storage.onDidChangeWorkspaceScope(() => this._reset())
  }

  private _ensureLoaded(): Promise<void> {
    this._loadPromise ??= this._load()
    return this._loadPromise
  }

  private async _load(): Promise<void> {
    const raw = await this._storage.get<PersistedRecentFile[]>(STORAGE_KEY, StorageScope.WORKSPACE)
    if (!raw) return
    const loaded = raw.map((r) => ({
      uri: URI.revive(r.uri) as URI,
      name: r.name,
      lastOpened: r.lastOpened,
    }))
    // Keep items already in-memory (added in this session before load completed).
    // Fill in from storage for URIs we don't have yet.
    const known = new Set(this._items.map((i) => i.uri.toString()))
    this._items = [...this._items, ...loaded.filter((l) => !known.has(l.uri.toString()))].slice(
      0,
      MAX_ITEMS,
    )
  }

  add(uri: URI, name: string): void {
    const entry: IRecentFile = { uri, name, lastOpened: Date.now() }
    const uriStr = uri.toString()
    this._items = [entry, ...this._items.filter((i) => i.uri.toString() !== uriStr)].slice(
      0,
      MAX_ITEMS,
    )
    void this._persist()
  }

  async getAll(): Promise<readonly IRecentFile[]> {
    await this._ensureLoaded()
    return this._items
  }

  clear(): void {
    this._items = []
    void this._persist()
  }

  /** Clear in-memory state on workspace swap so the next getAll() re-reads. */
  private _reset(): void {
    this._items = []
    this._loadPromise = null
  }

  private async _persist(): Promise<void> {
    // Ensure storage has been loaded before writing back, so we never
    // overwrite persisted items that haven't been merged into _items yet.
    await this._ensureLoaded()
    const data: PersistedRecentFile[] = this._items.map((i) => ({
      uri: i.uri.toJSON(),
      name: i.name,
      lastOpened: i.lastOpened,
    }))
    await this._storage.set(STORAGE_KEY, data, StorageScope.WORKSPACE)
  }
}
