/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for FileQuickAccessProvider: warms the full file listing once when the
 *  picker opens (reusing the @-mention cache) then filters it in-memory on every
 *  keystroke, the exact-path fast path, the 512 result cap, token cancellation,
 *  and the no-workspace fallback to the recent files list.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  Emitter,
  IEditorGroupsService,
  IEditorResolverService,
  IFileSearchService,
  IFileService,
  IInstantiationService,
  IWorkspaceService,
  InstantiationService,
  ServiceCollection,
  URI,
  UriIdentityService,
  IUriIdentityService,
  type CancellationToken,
  type IEditorResolverService as IEditorResolverServiceType,
  type IDisposable,
  type IEditorGroupsService as IEditorGroupsServiceType,
  type IFileSearchComplete,
  type IFileSearchService as IFileSearchServiceType,
  type IFileService as IFileServiceType,
  type IQuickInputButton,
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
import { invalidateMentionFileCache } from '../../acp/mentionFileSearch.js'

class FakeQuickPick<T extends IQuickPickItem> implements IQuickPick<T> {
  private readonly _onDidAccept = new Emitter<T[]>()
  private readonly _onDidHide = new Emitter<void>()
  private readonly _onDidChangeValue = new Emitter<string>()
  private readonly _onDidChangeActive = new Emitter<T | undefined>()
  readonly onDidAccept = this._onDidAccept.event
  readonly onDidHide = this._onDidHide.event
  readonly onDidChangeValue = this._onDidChangeValue.event
  readonly onDidChangeActive = this._onDidChangeActive.event

  private readonly _onDidTriggerButton = new Emitter<IQuickInputButton>()
  private readonly _onDidTriggerOk = new Emitter<void>()
  readonly onDidTriggerButton = this._onDidTriggerButton.event
  readonly onDidTriggerOk = this._onDidTriggerOk.event
  valueSelection: [number, number] | undefined
  activeItems: readonly T[] = []
  title: string | undefined
  buttons: readonly IQuickInputButton[] = []
  okLabel: string | undefined
  keepOpenOnAccept = false
  placeholder: string | undefined
  items: readonly QuickPickInput<T>[] = []
  prefix = ''
  mruIds: readonly string[] = []
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

  fireAccept(items: T[]): void {
    this._onDidAccept.fire(items)
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
    this._onDidTriggerButton.dispose()
    this._onDidTriggerOk.dispose()
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
    matchAll: boolean | undefined
    excludes: readonly string[]
    ignore: readonly string[]
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
        matchAll: query.matchAll,
        excludes: query.excludes ?? [],
        ignore: query.ignore ?? [],
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

/** Minimal IFileService: only exists() is exercised (exact-path fast path). */
function makeFileService(existing: Iterable<string> = []): IFileServiceType {
  const set = new Set([...existing].map((p) => URI.file(p).toString()))
  return {
    async exists(uri: URI): Promise<boolean> {
      return set.has(uri.toString())
    },
  } as unknown as IFileServiceType
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

/** Records openEditor calls so tests can assert the picker routes through the
 *  resolver (which picks custom editors for e.g. PDFs) rather than hard-coding a
 *  text editor. */
class FakeEditorResolverService implements IEditorResolverServiceType {
  declare readonly _serviceBrand: undefined
  readonly opened: Array<{ uri: URI; pinned: boolean | undefined }> = []
  registerEditor(): IDisposable {
    return { dispose() {} }
  }
  resolveEditors() {
    return []
  }
  async openEditor(uri: URI, options?: { preferredTypeId?: string; pinned?: boolean }) {
    this.opened.push({ uri, pinned: options?.pinned })
  }
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

function setup(
  opts: {
    root?: URI | null
    recent?: readonly IRecentFile[]
    exclude?: IExcludeService
    existingFiles?: Iterable<string>
  } = {},
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
  services.set(IUriIdentityService, new UriIdentityService('linux'))
  services.set(IFileService, makeFileService(opts.existingFiles))
  const resolver = new FakeEditorResolverService()
  services.set(IEditorResolverService, resolver)
  const inst = new InstantiationService(services)
  services.set(IInstantiationService, inst as unknown as IInstantiationService)
  const provider = inst.createInstance(FileQuickAccessProvider)
  return { provider, fileSearch, workspace, resolver }
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
    // The workspace listing is cached (module-level, shared with @-mention) with a
    // short TTL; clear it so each test walks fresh and asserts its own calls.
    invalidateMentionFileCache()
  })
  afterEach(() => {
    invalidateMentionFileCache()
  })

  it('enables external filtering and warms the full listing once, then filters in-memory', async () => {
    const { provider, fileSearch } = setup()
    fileSearch.resultPaths = ['/ws/src/a.ts', '/ws/src/b.ts']
    const picker = new FakeQuickPick<IQuickPickItem>()
    run(provider, picker)
    expect(picker.filterExternally).toBe(true)

    // The listing is prefetched on open (one matchAll walk), before any typing.
    await flushPromises()
    expect(fileSearch.calls).toHaveLength(1)
    expect(fileSearch.calls[0]!.matchAll).toBe(true)
    expect(fileSearch.calls[0]!.pattern).toBe('')

    // Typing filters the cached listing — no further search calls.
    picker.fireValue('a')
    expect(fileSearch.calls).toHaveLength(1)
    expect(picker.items).toHaveLength(1)
    expect(picker.items[0]).toMatchObject({ label: 'a.ts', description: 'src/a.ts' })

    picker.fireValue('b')
    expect(fileSearch.calls).toHaveLength(1)
    expect(picker.items[0]).toMatchObject({ label: 'b.ts', description: 'src/b.ts' })
  })

  it('re-runs the in-flight query once the listing lands (early keystroke not lost)', async () => {
    const { provider, fileSearch } = setup()
    fileSearch.deferred = true
    fileSearch.resultPaths = ['/ws/src/a.ts']
    const picker = new FakeQuickPick<IQuickPickItem>()
    run(provider, picker)

    // Type before the listing arrives: the picker shows the spinner, no items yet.
    picker.fireValue('a')
    expect(picker.busy).toBe(true)
    expect(picker.items).toHaveLength(0)

    // Listing lands → the current query re-runs against it.
    fileSearch.resolveAll()
    await flushPromises()
    expect(picker.busy).toBe(false)
    expect(picker.items).toHaveLength(1)
    expect(picker.items[0]).toMatchObject({ label: 'a.ts' })
  })

  it('forwards exclude globs / ignored dirs to the warm-up and caps results at 512', async () => {
    const exclude: IExcludeService = {
      _serviceBrand: undefined,
      onDidChange: new Emitter<void>().event,
      currentWatcherGlobs: [],
      isExcluded: () => false,
      getDirNameIgnores: () => ['node_modules'],
      getSearchExcludeGlobs: () => ['**/*.min.js'],
    }
    const { provider, fileSearch } = setup({ exclude })
    // 600 files all matching 'x' — filtering must cap the visible list at 512.
    fileSearch.resultPaths = Array.from({ length: 600 }, (_, i) => `/ws/x${i}.ts`)
    const picker = new FakeQuickPick<IQuickPickItem>()
    run(provider, picker)
    await flushPromises()

    expect(fileSearch.calls[0]!.excludes).toEqual(['**/*.min.js'])
    expect(fileSearch.calls[0]!.ignore).toEqual(['node_modules'])

    picker.fireValue('x')
    expect(picker.items).toHaveLength(512)
  })

  it('prepends an exact path match for a slash query even outside the listing', async () => {
    const { provider, fileSearch } = setup({ existingFiles: ['/ws/deep/exact.ts'] })
    // The listing does NOT contain the exact file; only the exists() probe finds it.
    fileSearch.resultPaths = ['/ws/src/other.ts']
    const picker = new FakeQuickPick<IQuickPickItem>()
    run(provider, picker)
    await flushPromises()

    picker.fireValue('deep/exact.ts')
    await flushPromises()
    expect(picker.items[0]).toMatchObject({ label: 'exact.ts', description: 'deep/exact.ts' })
  })

  it('discards results that arrive after the token is cancelled', async () => {
    const { provider, fileSearch } = setup()
    fileSearch.deferred = true
    fileSearch.resultPaths = ['/ws/late.ts']
    const picker = new FakeQuickPick<IQuickPickItem>()
    const { token } = run(provider, picker)

    picker.fireValue('late')
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

  it('seeds the empty query with all recent files, including those outside the workspace', async () => {
    const recent: IRecentFile[] = [
      { uri: URI.file('/ws/src/inside.ts'), name: 'inside.ts', lastOpened: 2 },
      { uri: URI.file('/elsewhere/outside.ts'), name: 'outside.ts', lastOpened: 1 },
    ]
    const { provider } = setup({ recent })
    const picker = new FakeQuickPick<IQuickPickItem>()
    run(provider, picker)
    await flushPromises()

    expect(picker.items.map((i) => (i as IQuickPickItem).label)).toEqual([
      'inside.ts',
      'outside.ts',
    ])
    expect(picker.items[0]).toMatchObject({ description: 'src/inside.ts' })
    expect(picker.items[1]).toMatchObject({ description: URI.file('/elsewhere/outside.ts').fsPath })
  })

  it('accepting a pick opens through the editor resolver (custom editors win)', async () => {
    const { provider, fileSearch, resolver } = setup()
    fileSearch.resultPaths = ['/ws/doc.pdf']
    const picker = new FakeQuickPick<IQuickPickItem>()
    run(provider, picker)
    await flushPromises()

    picker.fireValue('doc')
    expect(picker.items).toHaveLength(1)

    picker.fireAccept([picker.items[0] as IQuickPickItem])

    expect(resolver.opened).toHaveLength(1)
    expect(resolver.opened[0]!.uri.fsPath).toBe(URI.file('/ws/doc.pdf').fsPath)
    expect(resolver.opened[0]!.pinned).toBe(true)
  })
})
