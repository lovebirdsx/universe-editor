/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for FileQuickAccessProvider: debounced workspace search, excludes
 *  filtering, the result cap, token cancellation, and the no-workspace fallback
 *  to the recent files list. Migrated from the old GoToFileAction coverage.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  Emitter,
  IEditorGroupsService,
  IFileSearchService,
  IInstantiationService,
  IWorkspaceService,
  InstantiationService,
  ServiceCollection,
  URI,
  type CancellationToken,
  type IDisposable,
  type IEditorGroupsService as IEditorGroupsServiceType,
  type IFileSearchComplete,
  type IFileSearchService as IFileSearchServiceType,
  type IQuickPick,
  type IQuickPickItem,
  type IWorkspace,
  type IWorkspaceService as IWorkspaceServiceType,
  type QuickPickInput,
  type QuickPickPresentation,
} from '@universe-editor/platform'
import { FileQuickAccessProvider } from '../providers/FileQuickAccessProvider.js'
import { IExcludeService } from '../../exclude/ExcludeService.js'
import { FakeExcludeService } from '../../exclude/testing/fakeExcludeService.js'
import { IRecentFilesService, type IRecentFile } from '../../recentFiles/recentFilesService.js'

class FakeQuickPick<T extends IQuickPickItem> implements IQuickPick<T> {
  private readonly _onDidAccept = new Emitter<T[]>()
  private readonly _onDidHide = new Emitter<void>()
  private readonly _onDidChangeValue = new Emitter<string>()
  private readonly _onDidChangeActive = new Emitter<T | undefined>()
  readonly onDidAccept = this._onDidAccept.event
  readonly onDidHide = this._onDidHide.event
  readonly onDidChangeValue = this._onDidChangeValue.event
  readonly onDidChangeActive = this._onDidChangeActive.event
  placeholder: string | undefined
  items: readonly QuickPickInput<T>[] = []
  prefix = ''
  filterExternally = false
  filterMode: 'fuzzy' | 'word' = 'fuzzy'
  matchOnDescription = false
  matchOnDetail = false
  presentation: QuickPickPresentation = 'default'
  busy = false
  private _value = ''

  get value(): string {
    return this._value
  }

  set value(value: string) {
    this._value = value
  }

  fireValue(value: string): void {
    this._value = value
    this._onDidChangeValue.fire(value)
  }

  show(): void {}
  hide(): void {
    this._onDidHide.fire()
  }
  dispose(): void {
    this._onDidAccept.dispose()
    this._onDidHide.dispose()
    this._onDidChangeValue.dispose()
    this._onDidChangeActive.dispose()
  }
}

class FakeWorkspaceService implements IWorkspaceServiceType {
  declare readonly _serviceBrand: undefined
  readonly onDidChangeWorkspace = new Emitter<IWorkspace | null>().event
  readonly onDidChangeRecent = new Emitter<readonly never[]>().event
  current: IWorkspace | null
  readonly recent = [] as never[]
  readonly whenReady: Promise<void> = Promise.resolve()
  constructor(root: URI | null) {
    this.current = root ? { folder: root, name: 'ws' } : null
  }
  async openFolder() {}
  async closeFolder() {}
  async clearRecent() {}
  async removeRecent() {}
}

interface FakeFileSearch extends IFileSearchServiceType {
  readonly calls: Array<{
    pattern: string
    excludes: readonly string[]
    maxResults: number | undefined
  }>
  resultPaths: string[]
  deferred: boolean
  resolveAll(): void
}

function makeFileSearch(root: URI): FakeFileSearch {
  const calls: FakeFileSearch['calls'] = []
  const resolvers: Array<() => void> = []
  const rootPath = root.fsPath.replace(/\\/g, '/').replace(/\/$/, '')
  const svc: FakeFileSearch = {
    _serviceBrand: undefined,
    calls,
    resultPaths: [],
    deferred: false,
    resolveAll() {
      while (resolvers.length > 0) resolvers.pop()?.()
    },
    async search(query): Promise<IFileSearchComplete> {
      calls.push({
        pattern: query.pattern,
        excludes: query.excludes ?? [],
        maxResults: query.maxResults,
      })
      const max = query.maxResults ?? Number.MAX_SAFE_INTEGER
      const build = (): IFileSearchComplete => {
        const all = svc.resultPaths.map((p) => URI.file(p))
        const results = all.slice(0, max).map((uri, i) => {
          const norm = uri.fsPath.replace(/\\/g, '/')
          const relativePath = norm.startsWith(rootPath + '/')
            ? norm.slice(rootPath.length + 1)
            : norm
          return {
            resource: uri.toJSON(),
            fsPath: uri.fsPath,
            relativePath,
            basename: relativePath.split('/').at(-1) ?? relativePath,
            score: 1000 - i,
          }
        })
        return {
          results,
          limitHit: all.length > max,
          filesWalked: all.length,
          directoriesWalked: 1,
          durationMs: 1,
        }
      }
      if (!svc.deferred) return build()
      return new Promise<IFileSearchComplete>((resolve) => resolvers.push(() => resolve(build())))
    },
  }
  return svc
}

class FakeRecentFilesService implements IRecentFilesService {
  declare readonly _serviceBrand: undefined
  constructor(private readonly _items: readonly IRecentFile[] = []) {}
  add(): void {}
  async getAll(): Promise<readonly IRecentFile[]> {
    return this._items
  }
  clear(): void {}
}

function makeGroups(): IEditorGroupsServiceType {
  const group = {
    editors: [],
    openEditor() {},
    setActive() {},
  }
  return {
    activeGroup: group,
    groups: [group],
    activateGroup() {},
  } as unknown as IEditorGroupsServiceType
}

function flushPromises(): Promise<void> {
  return Promise.resolve().then(() => undefined)
}

function setup(
  opts: { root?: URI | null; recent?: readonly IRecentFile[]; exclude?: IExcludeService } = {},
) {
  const root = opts.root === undefined ? URI.file('/ws') : opts.root
  const workspace = new FakeWorkspaceService(root)
  const fileSearch = makeFileSearch(root ?? URI.file('/ws'))
  const recent = new FakeRecentFilesService(opts.recent ?? [])
  const services = new ServiceCollection()
  services.set(IWorkspaceService, workspace)
  services.set(IFileSearchService, fileSearch)
  services.set(IEditorGroupsService, makeGroups())
  services.set(IRecentFilesService, recent)
  services.set(IExcludeService, opts.exclude ?? new FakeExcludeService())
  const inst = new InstantiationService(services)
  services.set(IInstantiationService, inst as unknown as IInstantiationService)
  const provider = inst.createInstance(FileQuickAccessProvider)
  return { provider, fileSearch, workspace }
}

function run(
  provider: FileQuickAccessProvider,
  picker: IQuickPick<IQuickPickItem>,
): { token: { isCancellationRequested: boolean }; disposables: { dispose(): void } } {
  const store: IDisposable[] = []
  const tokenState = { isCancellationRequested: false }
  const token = {
    get isCancellationRequested() {
      return tokenState.isCancellationRequested
    },
    onCancellationRequested: new Emitter<void>().event,
  } as unknown as CancellationToken
  const disposables = {
    add<T extends IDisposable>(d: T): T {
      store.push(d)
      return d
    },
    dispose() {
      while (store.length > 0) store.pop()?.dispose()
    },
  }
  provider.provide(picker, { disposables: disposables as never, token, prefix: '' })
  return { token: tokenState, disposables }
}

describe('FileQuickAccessProvider', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('enables external filtering and debounces the search 200ms', async () => {
    const { provider, fileSearch } = setup()
    fileSearch.resultPaths = ['/ws/src/a.ts']
    const picker = new FakeQuickPick<IQuickPickItem>()
    run(provider, picker)
    expect(picker.filterExternally).toBe(true)

    picker.fireValue('a')
    await vi.advanceTimersByTimeAsync(199)
    expect(fileSearch.calls).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(1)
    await flushPromises()
    expect(fileSearch.calls).toHaveLength(1)
    expect(fileSearch.calls[0]!.pattern).toBe('a')
    expect(picker.items[0]).toMatchObject({ label: 'a.ts', description: 'src/a.ts' })
  })

  it('forwards exclude globs and caps results at 512', async () => {
    const exclude: IExcludeService = {
      _serviceBrand: undefined,
      onDidChange: new Emitter<void>().event,
      currentWatcherGlobs: [],
      isExcluded: () => false,
      getDirNameIgnores: () => ['node_modules'],
      getSearchExcludeGlobs: () => ['**/*.min.js'],
    }
    const { provider, fileSearch } = setup({ exclude })
    const picker = new FakeQuickPick<IQuickPickItem>()
    run(provider, picker)

    picker.fireValue('x')
    await vi.advanceTimersByTimeAsync(200)
    await flushPromises()
    expect(fileSearch.calls[0]!.excludes).toEqual(['**/*.min.js'])
    expect(fileSearch.calls[0]!.maxResults).toBe(512)
  })

  it('discards results that arrive after the token is cancelled', async () => {
    const { provider, fileSearch } = setup()
    fileSearch.deferred = true
    fileSearch.resultPaths = ['/ws/late.ts']
    const picker = new FakeQuickPick<IQuickPickItem>()
    const { token } = run(provider, picker)

    picker.fireValue('late')
    await vi.advanceTimersByTimeAsync(200)
    expect(fileSearch.calls).toHaveLength(1)

    token.isCancellationRequested = true
    fileSearch.resolveAll()
    await flushPromises()
    expect(picker.items).toHaveLength(0)
  })

  it('with no workspace, falls back to the recent files list without searching', async () => {
    const recent: IRecentFile[] = [{ uri: URI.file('/home/a.ts'), name: 'a.ts', lastOpened: 1 }]
    const { provider, fileSearch } = setup({ root: null, recent })
    const picker = new FakeQuickPick<IQuickPickItem>()
    run(provider, picker)
    await flushPromises()

    expect(fileSearch.calls).toHaveLength(0)
    expect(picker.matchOnDescription).toBe(true)
    expect(picker.items).toHaveLength(1)
    expect(picker.items[0]).toMatchObject({ label: 'a.ts' })
  })
})
