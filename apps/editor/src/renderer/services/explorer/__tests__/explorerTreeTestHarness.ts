/*---------------------------------------------------------------------------------------------
 *  Shared test harness for the Explorer tree service: an in-memory FakeFs, the
 *  workspace / watcher / storage fakes, and a makeInst that wires the DI graph
 *  the same way main.tsx does. Kept out of any *.test.ts so vitest doesn't run
 *  it as a suite; imported by the ExplorerTreeService test files.
 *--------------------------------------------------------------------------------------------*/

import { vi } from 'vitest'
import {
  Emitter,
  Event,
  IFileService,
  IFileWatcherService,
  ILoggerService,
  IStorageService,
  IWorkspaceService,
  InstantiationService,
  LogLevel,
  ServiceCollection,
  StorageScope,
  URI,
  type IDirectoryEntry,
  type IFileChangeEvent,
  type IFileService as IFileServiceType,
  type IFileWatcherService as IFileWatcherServiceType,
  type ILogger,
  type IStorageService as IStorageServiceType,
  type IWorkspace,
  type IWorkspaceService as IWorkspaceServiceType,
  type UriComponents,
} from '@universe-editor/platform'
import { IExcludeService } from '../../exclude/ExcludeService.js'
import { FakeExcludeService } from '../../exclude/testing/fakeExcludeService.js'
import { IFocusScopeService } from '../../focus/FocusScopeService.js'
import { FakeFocusScopeService } from '../../focus/testing/fakeFocusScopeService.js'
import { IFileClipboardService } from '../../../../shared/ipc/fileClipboardService.js'

export interface FakeFs extends IFileServiceType {
  dirs: Map<string, IDirectoryEntry[]>
  files: Set<string>
  calls: {
    list: string[]
    writeFile: string[]
    createDirectory: string[]
    rename: string[]
    copy: string[]
    delete: string[]
  }
}

export function makeFs(initial: Record<string, IDirectoryEntry[]> = {}): FakeFs {
  const dirs = new Map<string, IDirectoryEntry[]>()
  for (const [k, v] of Object.entries(initial)) dirs.set(k, v)
  const files = new Set<string>()
  const calls = {
    list: [] as string[],
    writeFile: [] as string[],
    createDirectory: [] as string[],
    rename: [] as string[],
    copy: [] as string[],
    delete: [] as string[],
  }
  const basename = (resource: URI) => resource.path.split('/').at(-1) ?? resource.path
  const parent = (resource: URI): URI | null => {
    const slash = resource.path.lastIndexOf('/')
    if (slash <= 0) return null
    return resource.with({ path: resource.path.slice(0, slash) })
  }
  const removeParentEntry = (resource: URI) => {
    const p = parent(resource)
    if (!p) return
    const entries = dirs.get(p.toString())
    if (!entries) return
    dirs.set(
      p.toString(),
      entries.filter((entry) => entry.name !== basename(resource)),
    )
  }
  const upsertParentEntry = (resource: URI, isDirectory: boolean) => {
    const p = parent(resource)
    if (!p) return
    const entries = dirs.get(p.toString()) ?? []
    const name = basename(resource)
    if (!entries.some((entry) => entry.name === name)) {
      dirs.set(p.toString(), [...entries, { name, isFile: !isDirectory, isDirectory }])
    }
  }
  return {
    _serviceBrand: undefined,
    dirs,
    files,
    calls,
    async readFile() {
      throw new Error('not used')
    },
    async readFileHead() {
      throw new Error('not used')
    },
    async readFileText() {
      throw new Error('not used')
    },
    async writeFile(resource: URI) {
      calls.writeFile.push(resource.toString())
      files.add(resource.toString())
      upsertParentEntry(resource, false)
    },
    async exists(resource: URI) {
      return files.has(resource.toString()) || dirs.has(resource.toString())
    },
    async stat() {
      throw new Error('not used')
    },
    async list(resource: URI) {
      calls.list.push(resource.toString())
      const entries = dirs.get(resource.toString())
      if (!entries) {
        // Mirror a real fs: listing a missing directory rejects (ENOENT), it
        // does not silently yield an empty listing — the tree's error path and
        // the restore self-heal both key off that rejection.
        throw new Error(`ENOENT: no such directory '${resource.toString()}'`)
      }
      return entries
    },
    async createDirectory(resource: URI) {
      calls.createDirectory.push(resource.toString())
      dirs.set(resource.toString(), [])
      upsertParentEntry(resource, true)
    },
    async delete(resource: URI) {
      calls.delete.push(resource.toString())
      files.delete(resource.toString())
      dirs.delete(resource.toString())
      removeParentEntry(resource)
      const prefix = resource.toString() + '/'
      for (const key of [...files]) {
        if (key.startsWith(prefix)) files.delete(key)
      }
      for (const key of [...dirs.keys()]) {
        if (key.startsWith(prefix)) dirs.delete(key)
      }
    },
    async rename(source: URI, target: URI, opts?: { overwrite?: boolean }) {
      calls.rename.push(`${source.toString()}→${target.toString()}`)
      if (
        opts?.overwrite !== true &&
        (files.has(target.toString()) || dirs.has(target.toString()))
      ) {
        throw new Error('target exists')
      }
      if (files.delete(source.toString())) {
        if (opts?.overwrite === true) {
          files.delete(target.toString())
          dirs.delete(target.toString())
        }
        files.add(target.toString())
        removeParentEntry(source)
        upsertParentEntry(target, false)
      }
      if (dirs.has(source.toString())) {
        if (opts?.overwrite === true) {
          files.delete(target.toString())
          dirs.delete(target.toString())
        }
        const moved: Array<[string, IDirectoryEntry[]]> = []
        const sourcePrefix = source.toString() + '/'
        for (const [key, value] of dirs) {
          if (key === source.toString() || key.startsWith(sourcePrefix)) {
            moved.push([key, value])
          }
        }
        for (const [key] of moved) dirs.delete(key)
        for (const [key, value] of moved) {
          dirs.set(key.replace(source.toString(), target.toString()), value)
        }
        removeParentEntry(source)
        upsertParentEntry(target, true)
      }
    },
    async copy(source: URI, target: URI, opts?: { overwrite?: boolean }) {
      calls.copy.push(`${source.toString()}→${target.toString()}`)
      if (
        opts?.overwrite !== true &&
        (files.has(target.toString()) || dirs.has(target.toString()))
      ) {
        throw new Error('target exists')
      }
      if (files.has(source.toString())) {
        files.add(target.toString())
        upsertParentEntry(target, false)
        return
      }
      if (dirs.has(source.toString())) {
        const sourcePrefix = source.toString() + '/'
        for (const [key, value] of [...dirs]) {
          if (key === source.toString() || key.startsWith(sourcePrefix)) {
            dirs.set(key.replace(source.toString(), target.toString()), [...value])
          }
        }
        for (const key of [...files]) {
          if (key.startsWith(sourcePrefix)) {
            files.add(key.replace(source.toString(), target.toString()))
          }
        }
        upsertParentEntry(target, true)
      }
    },
    async listRecursive() {
      return []
    },
  } as FakeFs
}

export class FakeWorkspaceService implements IWorkspaceServiceType {
  declare readonly _serviceBrand: undefined
  private readonly _changed = new Emitter<IWorkspace | null>()
  readonly onDidChangeWorkspace = this._changed.event
  readonly onDidChangeRecent = new Emitter<readonly never[]>().event
  current: IWorkspace | null
  readonly recent = [] as never[]
  readonly whenReady: Promise<void> = Promise.resolve()

  constructor(initial: URI | null) {
    this.current = initial ? { folder: initial, name: 'ws' } : null
  }

  async openFolder() {}
  async closeFolder() {}
  async clearRecent() {}
  async removeRecent() {}

  setRoot(folder: URI | null) {
    this.current = folder ? { folder, name: 'ws' } : null
    this._changed.fire(this.current)
  }
}

export class FakeWatcher implements IFileWatcherServiceType {
  declare readonly _serviceBrand: undefined
  private readonly _emitter = new Emitter<readonly IFileChangeEvent[]>()
  readonly onDidChangeFiles = this._emitter.event
  readonly onDidRestart = Event.None
  readonly watched: UriComponents[] = []
  unwatchCalls = 0
  async watch(folder: UriComponents): Promise<void> {
    this.watched.push(folder)
  }
  async setExcludes(): Promise<void> {}
  async unwatch(): Promise<void> {
    this.unwatchCalls++
  }
  async watchOutOfWorkspace(): Promise<void> {}
  async addOutOfWorkspaceFolder(): Promise<void> {}
  async removeOutOfWorkspaceFolder(): Promise<void> {}
  async clearOutOfWorkspaceFolders(): Promise<void> {}
  fire(events: readonly IFileChangeEvent[]): void {
    this._emitter.fire(events)
  }
}

export class FakeStorage implements IStorageServiceType {
  declare readonly _serviceBrand: undefined
  private readonly _scopeChanged = new Emitter<void>()
  readonly onDidChangeWorkspaceScope = this._scopeChanged.event
  private readonly _global = new Map<string, unknown>()
  private readonly _workspace = new Map<string, unknown>()
  /** Workspace-scope view — the explorer tree state lives here. */
  get store(): Map<string, unknown> {
    return this._workspace
  }
  private _bucket(scope?: StorageScope): Map<string, unknown> {
    return scope === StorageScope.WORKSPACE ? this._workspace : this._global
  }
  async get<T = unknown>(key: string, scope?: StorageScope): Promise<T | undefined> {
    return this._bucket(scope).get(key) as T | undefined
  }
  async set(key: string, value: unknown, scope?: StorageScope): Promise<void> {
    this._bucket(scope).set(key, value)
  }
  async remove(key: string, scope?: StorageScope): Promise<void> {
    this._bucket(scope).delete(key)
  }
  /** Simulate the main-side workspace-storage backend (re)hydrating. */
  fireWorkspaceScopeChange(): void {
    this._scopeChanged.fire()
  }
}

export function makeInst(
  fs: IFileServiceType,
  ws: IWorkspaceServiceType,
  watcher: IFileWatcherServiceType,
  logger?: ILogger,
  fileClipboard?: IFileClipboardService,
  focus?: IFocusScopeService,
  exclude?: IExcludeService,
  storage?: IStorageServiceType,
): InstantiationService {
  const services = new ServiceCollection()
  services.set(IFileService, fs)
  services.set(IWorkspaceService, ws)
  services.set(IFileWatcherService, watcher)
  services.set(IExcludeService, exclude ?? new FakeExcludeService())
  services.set(IFocusScopeService, focus ?? new FakeFocusScopeService())
  services.set(IStorageService, storage ?? new FakeStorage())
  if (fileClipboard) {
    services.set(IFileClipboardService, fileClipboard)
  }
  if (logger) {
    services.set(ILoggerService, {
      _serviceBrand: undefined,
      createLogger: () => logger,
      setLevel: () => {},
      getLevel: () => LogLevel.Info,
    })
  }
  return new InstantiationService(services)
}

export function makeFileClipboard(): IFileClipboardService & {
  writeResources: ReturnType<typeof vi.fn>
  clear: ReturnType<typeof vi.fn>
} {
  const service = {
    _serviceBrand: undefined,
    onDidChangeClipboard: Event.None,
    writeResources: vi.fn(async () => {}),
    readResources: vi.fn(async () => ({ resources: [], isCut: false, source: 'os' as const })),
    checkWriteCost: vi.fn(async () => ({
      materializeCount: 0,
      totalBytes: 0,
      needsConfirmation: false,
      refused: false,
    })),
    clear: vi.fn(async () => {}),
  }
  return service as unknown as IFileClipboardService & {
    writeResources: ReturnType<typeof vi.fn>
    clear: ReturnType<typeof vi.fn>
  }
}

export function makeLogger(): ILogger {
  return {
    level: LogLevel.Info,
    onDidChangeLogLevel: Event.None,
    setLevel: vi.fn(),
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    flush: vi.fn(),
    dispose: vi.fn(),
  }
}

export function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0))
}
