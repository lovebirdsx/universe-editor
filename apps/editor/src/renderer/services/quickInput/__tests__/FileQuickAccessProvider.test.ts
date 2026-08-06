/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for FileQuickAccessProvider: warms the full file listing once when the
 *  picker opens (reusing the @-mention cache) then filters it in-memory on every
 *  keystroke, the exact-path fast path, the 512 result cap, token cancellation,
 *  open editors (all types) mixed into the empty-query list and fuzzy matching,
 *  and the no-workspace fallback to the recent files list. Large listings get
 *  their own block: chunked off-keystroke scanning and match-set narrowing.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EditorInput,
  EditorRegistry,
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
  type IEditorGroup,
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
import { IRecentEditorsService } from '../../editor/RecentEditorsService.js'
import { IClosedEditorsService, type ClosedEditorEntry } from '../../editor/ClosedEditorsService.js'
import { invalidateMentionFileCache } from '../../acp/mentionFileSearch.js'
import { resourceIconId } from '../quickPickResourceIcon.js'

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
  keyMods = { ctrl: false, alt: false }
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
  /** 模拟主进程预热 walk 截断：matchAll 调用最多返回这么多条并置 limitHit。
   *  打分搜索（带 pattern 的兜底）是全树 top-K，不受此截断。 */
  truncateAt: number | undefined
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
    truncateAt: undefined,
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
      const max = Math.min(
        query.maxResults ?? Number.MAX_SAFE_INTEGER,
        (query.matchAll ? svc.truncateAt : undefined) ?? Number.MAX_SAFE_INTEGER,
      )
      const pattern = query.pattern.trim().toLowerCase()
      const build = (): IFileSearchComplete => {
        const all = svc.resultPaths
          .map((p) => URI.file(p))
          .filter((uri) => {
            if (query.matchAll || pattern.length === 0) return true
            return uri.fsPath.replace(/\\/g, '/').toLowerCase().includes(pattern)
          })
        const results = all.slice(0, max).map((uri, i) => {
          const norm = uri.fsPath.replace(/\\/g, '/')
          const relativePath = norm.startsWith(rootPath + '/')
            ? norm.slice(rootPath.length + 1)
            : norm
          return {
            resource: uri,
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

function makeGroups(openEditors: EditorInput[] = [], sideEditors: EditorInput[] = []) {
  const activatedGroupIds: number[] = []
  const setActiveLog: EditorInput[] = []
  const openLog: Array<{ groupId: number; editor: EditorInput; options: unknown }> = []
  let nextId = 1
  const makeGroup = (editors: EditorInput[]) => {
    const id = nextId++
    return {
      id,
      editors,
      openEditor(editor: EditorInput, options?: unknown) {
        openLog.push({ groupId: id, editor, options })
      },
      setActive(editor: EditorInput) {
        setActiveLog.push(editor)
      },
    }
  }
  const group = makeGroup(openEditors)
  const all = sideEditors.length > 0 ? [group, makeGroup(sideEditors)] : [group]
  let active = group
  const groups = {
    get activeGroup() {
      return active
    },
    get groups() {
      return all
    },
    activateGroup(g: { id: number }) {
      activatedGroupIds.push(g.id)
      const found = all.find((x) => x.id === g.id)
      if (found) active = found
    },
    getGroup(id: number) {
      return all.find((x) => x.id === id)
    },
    findGroup(_scope: unknown, source?: { id: number }, wrap?: boolean) {
      const idx = all.indexOf((source ?? active) as never)
      const next = all[idx + 1]
      if (next) return next
      return wrap ? all[0] : undefined
    },
    addGroup() {
      const g = makeGroup([])
      all.push(g)
      return g
    },
  } as unknown as IEditorGroupsServiceType
  return { groups, group, activatedGroupIds, setActiveLog, openLog, all }
}

class FakeEditorInput extends EditorInput {
  constructor(
    private readonly _typeId: string,
    private readonly _resource: URI | undefined,
    private readonly _name: string,
  ) {
    super()
  }
  override get typeId(): string {
    return this._typeId
  }
  override get resource(): URI | undefined {
    return this._resource
  }
  override getName(): string {
    return this._name
  }
}

class FakeRecentEditorsService implements IRecentEditorsService {
  declare readonly _serviceBrand: undefined
  constructor(private readonly _items: readonly { editor: EditorInput; group: IEditorGroup }[]) {}
  getRecentEditors() {
    return this._items
  }
}

/** Takes entries from a fixed list: the newest resource match is removed and
 *  returned, mirroring ClosedEditorsService.takeMostRecentMatching. */
class FakeClosedEditorsService implements IClosedEditorsService {
  declare readonly _serviceBrand: undefined
  readonly takeCalls: URI[] = []
  constructor(readonly entries: ClosedEditorEntry[] = []) {}
  popMostRecent(): ClosedEditorEntry | undefined {
    return undefined
  }
  getClosedEditors(): readonly ClosedEditorEntry[] {
    return [...this.entries].reverse()
  }
  takeMostRecentMatching(resource: URI): ClosedEditorEntry | undefined {
    this.takeCalls.push(resource)
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i]!
      if (entry.resource.toString() === resource.toString()) {
        this.entries.splice(i, 1)
        return entry
      }
    }
    return undefined
  }
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
    openEditors?: EditorInput[]
    sideEditors?: EditorInput[]
    closedEntries?: ClosedEditorEntry[]
  } = {},
) {
  const root = opts.root === undefined ? URI.file('/ws') : opts.root
  const workspace = new FakeWorkspaceService(root)
  const fileSearch = makeFileSearch(root ?? URI.file('/ws'))
  const recent = new FakeRecentFilesService(opts.recent ?? [])
  const groupsFake = makeGroups(opts.openEditors ?? [], opts.sideEditors ?? [])
  const closedEditors = new FakeClosedEditorsService([...(opts.closedEntries ?? [])])
  const recentEditors = new FakeRecentEditorsService([
    ...(opts.openEditors ?? []).map((editor) => ({
      editor,
      group: groupsFake.all[0] as unknown as IEditorGroup,
    })),
    ...(opts.sideEditors ?? []).map((editor) => ({
      editor,
      group: groupsFake.all[1] as unknown as IEditorGroup,
    })),
  ])
  const services = new ServiceCollection()
  services.set(IWorkspaceService, workspace)
  services.set(IFileSearchService, fileSearch)
  services.set(IEditorGroupsService, groupsFake.groups)
  services.set(IRecentFilesService, recent)
  services.set(IRecentEditorsService, recentEditors)
  services.set(IClosedEditorsService, closedEditors)
  services.set(IExcludeService, opts.exclude ?? new FakeExcludeService())
  services.set(IUriIdentityService, new UriIdentityService('linux'))
  services.set(IFileService, makeFileService(opts.existingFiles))
  const resolver = new FakeEditorResolverService()
  services.set(IEditorResolverService, resolver)
  const inst = new InstantiationService(services)
  services.set(IInstantiationService, inst as unknown as IInstantiationService)
  const provider = inst.createInstance(FileQuickAccessProvider)
  return { provider, fileSearch, workspace, resolver, groupsFake, closedEditors }
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

  it('probes the exact path while the listing is still warming (cold cache)', async () => {
    const { provider, fileSearch } = setup({ existingFiles: ['/ws/deep/exact.ts'] })
    fileSearch.deferred = true
    fileSearch.resultPaths = ['/ws/src/other.ts']
    const picker = new FakeQuickPick<IQuickPickItem>()
    run(provider, picker)

    // The walk hasn't landed, yet a path-shaped query resolves via the single
    // exists() probe instead of waiting for the full listing.
    picker.fireValue('deep/exact.ts')
    await flushPromises()
    expect(picker.busy).toBe(true)
    expect(picker.items[0]).toMatchObject({ label: 'exact.ts', description: 'deep/exact.ts' })

    // Once the walk lands the query re-runs against the full listing; the
    // exact-path pick stays (still probed, still not in the listing).
    fileSearch.resolveAll()
    await flushPromises()
    expect(picker.busy).toBe(false)
    expect(picker.items[0]).toMatchObject({ label: 'exact.ts', description: 'deep/exact.ts' })
  })

  it('seeds from the stale cached listing instantly, then re-runs when fresh files land', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      // First session warms the module-level listing cache.
      const first = setup()
      first.fileSearch.resultPaths = ['/ws/src/stale.ts']
      const picker1 = new FakeQuickPick<IQuickPickItem>()
      const session1 = run(first.provider, picker1)
      await flushPromises()
      session1.disposables.dispose()

      // Past the TTL the cached listing is stale.
      vi.setSystemTime(Date.now() + 60 * 60_000)

      // Second session: the revalidating walk is deferred, but the stale
      // listing still filters instantly — no spinner wait for the user.
      const second = setup()
      second.fileSearch.deferred = true
      second.fileSearch.resultPaths = ['/ws/src/fresh.ts']
      const picker2 = new FakeQuickPick<IQuickPickItem>()
      run(second.provider, picker2)

      picker2.fireValue('ts')
      expect(picker2.items.map((i) => (i as IQuickPickItem).label)).toEqual(['stale.ts'])

      second.fileSearch.resolveAll()
      await flushPromises()
      expect(picker2.items.map((i) => (i as IQuickPickItem).label)).toEqual(['fresh.ts'])
    } finally {
      vi.useRealTimers()
    }
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

  it('ignores value events fired after the token is cancelled (stale snapshot dispatch)', async () => {
    // Emitter 是快照派发：controller 路由切换（如重新输入 '>'）时已先 cancel 本
    // provider 的 token，但本次 fire 里 runSearch 仍会被残留调用——此时绝不能改写
    // picker 状态，否则会覆盖新激活 provider 刚设置的 items。
    const { provider, fileSearch } = setup()
    fileSearch.resultPaths = ['/ws/src/a.ts']
    const picker = new FakeQuickPick<IQuickPickItem>()
    const { token } = run(provider, picker)
    await flushPromises()

    picker.fireValue('a')
    const itemsBefore = picker.items
    expect(itemsBefore).toHaveLength(1)
    expect(picker.busy).toBe(false)

    token.isCancellationRequested = true
    picker.fireValue('>')
    expect(picker.items).toBe(itemsBefore)
    expect(picker.busy).toBe(false)
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

  it('heads the empty query with all open editors, deduping recent files by resource', async () => {
    const fileEditor = new FakeEditorInput('file', URI.file('/ws/src/a.ts'), 'a.ts')
    const preview = new FakeEditorInput(
      'markdown.preview',
      URI.parse('markdown-preview:/ws/src/a.md'),
      'Preview a.md',
    )
    const settings = new FakeEditorInput('settings', undefined, 'Settings')
    const recent: IRecentFile[] = [
      { uri: URI.file('/ws/src/a.ts'), name: 'a.ts', lastOpened: 2 },
      { uri: URI.file('/ws/other.ts'), name: 'other.ts', lastOpened: 1 },
    ]
    const { provider } = setup({ recent, openEditors: [fileEditor, preview, settings] })
    const picker = new FakeQuickPick<IQuickPickItem>()
    run(provider, picker)
    await flushPromises()

    // Open editors in MRU order, then recents with the already-open a.ts dropped.
    expect(picker.items.map((i) => (i as IQuickPickItem).label)).toEqual([
      'a.ts',
      'Preview a.md',
      'Settings',
      'other.ts',
    ])
    expect(picker.items[0]).toMatchObject({
      id: URI.file('/ws/src/a.ts').toString(),
      description: 'src/a.ts',
    })
  })

  it('matches open non-text editors while typing', async () => {
    const settings = new FakeEditorInput('settings', undefined, 'Settings')
    const { provider, fileSearch } = setup({ openEditors: [settings] })
    fileSearch.resultPaths = ['/ws/src/a.ts']
    const picker = new FakeQuickPick<IQuickPickItem>()
    run(provider, picker)
    await flushPromises()

    picker.fireValue('sett')
    expect(picker.items.map((i) => (i as IQuickPickItem).label)).toEqual(['Settings'])
  })

  it('accepting a virtual editor pick activates the live editor instead of resolving', async () => {
    const settings = new FakeEditorInput('settings', undefined, 'Settings')
    const { provider, resolver, groupsFake } = setup({ openEditors: [settings] })
    const picker = new FakeQuickPick<IQuickPickItem>()
    run(provider, picker)
    await flushPromises()

    expect(picker.items[0]).toMatchObject({ label: 'Settings' })
    picker.fireAccept([picker.items[0] as IQuickPickItem])

    expect(groupsFake.activatedGroupIds).toEqual([1])
    expect(groupsFake.setActiveLog).toEqual([settings])
    expect(resolver.opened).toHaveLength(0)
  })

  it('accepting a resource-backed editor pick activates the open editor by URI', async () => {
    const fileEditor = new FakeEditorInput('file', URI.file('/ws/src/a.ts'), 'a.ts')
    const { provider, resolver, groupsFake } = setup({ openEditors: [fileEditor] })
    const picker = new FakeQuickPick<IQuickPickItem>()
    run(provider, picker)
    await flushPromises()

    picker.fireAccept([picker.items[0] as IQuickPickItem])

    expect(groupsFake.setActiveLog).toEqual([fileEditor])
    expect(resolver.opened).toHaveLength(0)
  })

  it('with no workspace, lists open editors ahead of recent files', async () => {
    const settings = new FakeEditorInput('settings', undefined, 'Settings')
    const recent: IRecentFile[] = [{ uri: URI.file('/home/a.ts'), name: 'a.ts', lastOpened: 1 }]
    const { provider } = setup({ root: null, recent, openEditors: [settings] })
    const picker = new FakeQuickPick<IQuickPickItem>()
    run(provider, picker)
    await flushPromises()

    expect(picker.items.map((i) => (i as IQuickPickItem).label)).toEqual(['Settings', 'a.ts'])
  })

  it('ctrl+accept opens to the side: a new group is created when there is only one', async () => {
    const { provider, fileSearch, resolver, groupsFake } = setup()
    fileSearch.resultPaths = ['/ws/src/b.ts']
    const picker = new FakeQuickPick<IQuickPickItem>()
    picker.keyMods = { ctrl: true, alt: false }
    run(provider, picker)
    await flushPromises()

    picker.fireValue('b')
    picker.fireAccept([picker.items[0] as IQuickPickItem])

    // addGroup appended a second group and it became the active (side) target.
    expect(groupsFake.all).toHaveLength(2)
    expect(groupsFake.activatedGroupIds).toEqual([2])
    expect(resolver.opened).toHaveLength(1)
    expect(resolver.opened[0]!.uri.fsPath).toBe(URI.file('/ws/src/b.ts').fsPath)
    expect(resolver.opened[0]!.pinned).toBe(true)
  })

  it('ctrl+accept reuses the existing side group and activates a match already open there', async () => {
    const sideEditor = new FakeEditorInput('file', URI.file('/ws/src/b.ts'), 'b.ts')
    const { provider, fileSearch, resolver, groupsFake } = setup({ sideEditors: [sideEditor] })
    fileSearch.resultPaths = ['/ws/src/b.ts']
    const picker = new FakeQuickPick<IQuickPickItem>()
    picker.keyMods = { ctrl: true, alt: false }
    run(provider, picker)
    await flushPromises()

    picker.fireValue('b')
    picker.fireAccept([picker.items[0] as IQuickPickItem])

    // Existing side group reused (no new group), matched editor activated in it.
    expect(groupsFake.all).toHaveLength(2)
    expect(groupsFake.activatedGroupIds).toEqual([2])
    expect(groupsFake.setActiveLog).toEqual([sideEditor])
    expect(resolver.opened).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Large listings: chunked filtering off the keystroke + match-set narrowing
// ---------------------------------------------------------------------------

describe('FileQuickAccessProvider — large listing (chunked filter + narrowing)', () => {
  // 超过 provider 的 SYNC_FILTER_LIMIT（5000）即走分块异步路径。
  const LARGE = 6000

  beforeEach(() => {
    invalidateMentionFileCache()
  })
  afterEach(() => {
    invalidateMentionFileCache()
    vi.restoreAllMocks()
  })

  it('filters a large listing off the keystroke: async publication, still capped at 512', async () => {
    const { provider, fileSearch } = setup()
    fileSearch.resultPaths = Array.from({ length: LARGE }, (_, i) => `/ws/x${i}.ts`)
    const picker = new FakeQuickPick<IQuickPickItem>()
    run(provider, picker)
    await flushPromises()

    picker.fireValue('x')
    // 大清单不再同步出结果：击键处理返回时列表尚未更新，busy 亮起。
    expect(picker.items).toHaveLength(0)
    expect(picker.busy).toBe(true)

    await vi.waitFor(() => expect(picker.busy).toBe(false))
    expect(picker.items).toHaveLength(512)
  })

  it('a superseding keystroke aborts the in-flight chunked scan (only the newest publishes)', async () => {
    // 每次 deadline 检查都触发让出，制造真实的多分片扫描与中途放弃。
    let t = 0
    vi.spyOn(performance, 'now').mockImplementation(() => (t += 5))
    const { provider, fileSearch } = setup()
    fileSearch.resultPaths = [
      ...Array.from({ length: LARGE / 2 }, (_, i) => `/ws/red${i}.ts`),
      ...Array.from({ length: LARGE / 2 }, (_, i) => `/ws/blue${i}.ts`),
    ]
    const picker = new FakeQuickPick<IQuickPickItem>()
    run(provider, picker)
    await flushPromises()

    picker.fireValue('red')
    picker.fireValue('blue')

    await vi.waitFor(() => expect(picker.busy).toBe(false))
    expect(picker.items).toHaveLength(512)
    for (const item of picker.items) {
      expect((item as IQuickPickItem).label.startsWith('blue')).toBe(true)
    }
  })

  it('an extending keystroke narrows over the completed match set (sync fast path)', async () => {
    const { provider, fileSearch } = setup()
    fileSearch.resultPaths = [
      ...Array.from({ length: LARGE - 20 }, (_, i) => `/ws/f${i}.md`),
      ...Array.from({ length: 10 }, (_, i) => `/ws/needle-a${i}.ts`),
      ...Array.from({ length: 10 }, (_, i) => `/ws/needle-b${i}.ts`),
    ]
    const picker = new FakeQuickPick<IQuickPickItem>()
    run(provider, picker)
    await flushPromises()

    picker.fireValue('needle')
    await vi.waitFor(() => expect(picker.busy).toBe(false))
    expect(picker.items).toHaveLength(20)

    // 上一轮命中 20 条 → 追加字符后的候选池落回同步阈值内，结果同步落地。
    picker.fireValue('needleb')
    expect(picker.items.map((i) => (i as IQuickPickItem).label)).toEqual(
      Array.from({ length: 10 }, (_, i) => `needle-b${i}.ts`),
    )
  })

  it('discards a chunked scan when the token is cancelled before it publishes', async () => {
    const { provider, fileSearch } = setup()
    fileSearch.resultPaths = Array.from({ length: LARGE }, (_, i) => `/ws/x${i}.ts`)
    const picker = new FakeQuickPick<IQuickPickItem>()
    const { token } = run(provider, picker)
    await flushPromises()

    picker.fireValue('x')
    token.isCancellationRequested = true
    await flushPromises()
    await flushPromises()
    expect(picker.items).toHaveLength(0)
  })

  it('a fresh listing resets the narrowing pool (the auto re-run sees new files)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const first = setup()
      first.fileSearch.resultPaths = ['/ws/rest.ts']
      const picker1 = new FakeQuickPick<IQuickPickItem>()
      const session1 = run(first.provider, picker1)
      await flushPromises()
      session1.disposables.dispose()

      vi.setSystemTime(Date.now() + 60 * 60_000)

      const second = setup()
      second.fileSearch.deferred = true
      second.fileSearch.resultPaths = ['/ws/rest.ts', '/ws/realm.ts']
      const picker2 = new FakeQuickPick<IQuickPickItem>()
      run(second.provider, picker2)

      // Stale 池上完成一轮 're' 扫描（命中仅 rest.ts）……
      picker2.fireValue('re')
      expect(picker2.items.map((i) => (i as IQuickPickItem).label)).toEqual(['rest.ts'])

      // ……新清单落地后自动重跑同一 pattern：若收窄池未重置，realm.ts 永远出不来。
      second.fileSearch.resolveAll()
      await flushPromises()
      expect(picker2.items.map((i) => (i as IQuickPickItem).label)).toEqual(['rest.ts', 'realm.ts'])
    } finally {
      vi.useRealTimers()
    }
  })
})

// ---------------------------------------------------------------------------
// Truncated listings: the cached pool is a subset of the workspace, so typing
// must also fall back to a scored main-process search (regression: on a
// multi-million-file workspace files outside the 100k warm-up cap could never
// be found through Ctrl+P)
// ---------------------------------------------------------------------------

describe('FileQuickAccessProvider — truncated listing (main-search fallback)', () => {
  beforeEach(() => {
    invalidateMentionFileCache()
  })
  afterEach(() => {
    invalidateMentionFileCache()
  })

  it('finds a file outside the truncated cached listing via the fallback search', async () => {
    const { provider, fileSearch } = setup()
    fileSearch.resultPaths = ['/ws/src/a.ts', '/ws/src/b.ts', '/ws/deep/nested/iaction.ts']
    fileSearch.truncateAt = 2
    const picker = new FakeQuickPick<IQuickPickItem>()
    run(provider, picker)
    await flushPromises()

    picker.fireValue('iaction')
    await flushPromises()

    expect(fileSearch.calls).toHaveLength(2)
    expect(fileSearch.calls[1]!.pattern).toBe('iaction')
    expect(fileSearch.calls[1]!.matchAll).toBeUndefined()
    expect(picker.items.map((i) => (i as IQuickPickItem).label)).toEqual(['iaction.ts'])
    expect(picker.busy).toBe(false)
  })

  it('shows cached hits instantly, then merges fallback hits deduped by resource', async () => {
    const { provider, fileSearch } = setup()
    fileSearch.resultPaths = ['/ws/xa.ts', '/ws/xb.ts', '/ws/xc.ts']
    fileSearch.truncateAt = 2
    const picker = new FakeQuickPick<IQuickPickItem>()
    run(provider, picker)
    await flushPromises()

    picker.fireValue('x')
    // 缓存池命中即时可见，同时兜底搜索仍在跑（busy 亮起）。
    expect(picker.items.map((i) => (i as IQuickPickItem).label)).toEqual(['xa.ts', 'xb.ts'])
    expect(picker.busy).toBe(true)

    await flushPromises()
    expect(picker.items.map((i) => (i as IQuickPickItem).label)).toEqual([
      'xa.ts',
      'xb.ts',
      'xc.ts',
    ])
    expect(picker.busy).toBe(false)
  })

  it('a superseding keystroke discards the stale fallback result', async () => {
    const { provider, fileSearch } = setup()
    fileSearch.resultPaths = ['/ws/xa.ts', '/ws/xb.ts', '/ws/xc.ts']
    fileSearch.truncateAt = 2
    const picker = new FakeQuickPick<IQuickPickItem>()
    run(provider, picker)
    await flushPromises()

    fileSearch.deferred = true
    picker.fireValue('xa')
    picker.fireValue('xc')
    fileSearch.resolveAll()
    await flushPromises()

    expect(picker.items.map((i) => (i as IQuickPickItem).label)).toEqual(['xc.ts'])
    expect(picker.busy).toBe(false)
  })

  it('never falls back when the cached listing is complete', async () => {
    const { provider, fileSearch } = setup()
    fileSearch.resultPaths = ['/ws/src/a.ts', '/ws/src/b.ts']
    const picker = new FakeQuickPick<IQuickPickItem>()
    run(provider, picker)
    await flushPromises()

    picker.fireValue('a')
    await flushPromises()
    expect(fileSearch.calls).toHaveLength(1)
    expect(picker.items.map((i) => (i as IQuickPickItem).label)).toEqual(['a.ts'])
  })
})

// ---------------------------------------------------------------------------
// Restoring just-closed editors with their exact type (mirrors Ctrl+Shift+T)
// ---------------------------------------------------------------------------

describe('FileQuickAccessProvider — closed editor restore', () => {
  const FAKE_CUSTOM_TYPE = 'fake.custom.quickopen.test'
  const registryDisposables: IDisposable[] = []

  beforeEach(() => {
    invalidateMentionFileCache()
    registryDisposables.push(
      EditorRegistry.registerEditorProvider({
        typeId: FAKE_CUSTOM_TYPE,
        componentKey: 'fake.custom',
        deserialize: (data) => {
          const d = data as { resource?: unknown }
          if (typeof d?.resource !== 'string') return null
          return new FakeEditorInput(FAKE_CUSTOM_TYPE, URI.parse(d.resource), 'restored.custom')
        },
      }),
    )
  })

  afterEach(() => {
    invalidateMentionFileCache()
    while (registryDisposables.length > 0) registryDisposables.pop()?.dispose()
  })

  function closedEntry(resource: URI, groupId = 1, label = 'closed.editor'): ClosedEditorEntry {
    return {
      resource,
      typeId: FAKE_CUSTOM_TYPE,
      groupId,
      serializedData: {
        resource: resource.toString(),
      },
      label,
    }
  }

  it('a just-closed non-text editor stays listed in the empty query and while typing', async () => {
    const uri = URI.file('/ws/pic.png')
    const { provider, fileSearch } = setup({
      closedEntries: [closedEntry(uri, 1, 'pic.png')],
    })
    fileSearch.resultPaths = ['/ws/other.ts']
    const picker = new FakeQuickPick<IQuickPickItem>()
    run(provider, picker)
    await flushPromises()

    expect(picker.items[0]).toMatchObject({
      id: uri.toString(),
      label: 'pic.png',
      description: 'pic.png',
      iconId: resourceIconId(uri),
    })

    picker.fireValue('pic')
    expect(picker.items.map((i) => (i as IQuickPickItem).label)).toContain('pic.png')
  })

  it('a closed entry with a virtual-scheme resource is listed and restored, never resolved', async () => {
    const uri = URI.parse('markdown-preview:/ws/doc.md')
    const { provider, fileSearch, resolver, groupsFake } = setup({
      closedEntries: [closedEntry(uri, 1, 'Preview doc.md')],
    })
    fileSearch.resultPaths = ['/ws/doc.md']
    const picker = new FakeQuickPick<IQuickPickItem>()
    run(provider, picker)
    await flushPromises()

    expect(picker.items.map((i) => (i as IQuickPickItem).label)).toContain('Preview doc.md')

    picker.fireValue('preview')
    const previewPick = picker.items.find(
      (i) => (i as IQuickPickItem).label === 'Preview doc.md',
    ) as IQuickPickItem
    // Virtual-scheme closed entries get the same resource icon as when the
    // editor is open (FileIcon resolves the basename's extension).
    expect(previewPick.iconId).toBe(resourceIconId(uri))
    picker.fireAccept([previewPick])

    expect(groupsFake.openLog).toHaveLength(1)
    expect(groupsFake.openLog[0]!.editor.typeId).toBe(FAKE_CUSTOM_TYPE)
    expect(groupsFake.openLog[0]!.editor.resource?.toString()).toBe(uri.toString())
    expect(resolver.opened).toHaveLength(0)
  })

  it('closed entries whose type has no deserialize hook are not listed (terminals…)', async () => {
    const uri = URI.file('/ws/a.term')
    const entry: ClosedEditorEntry = {
      resource: uri,
      typeId: 'fake.unregistered.quickopen.test',
      groupId: 1,
      serializedData: null,
      label: 'a.term',
    }
    const { provider, fileSearch } = setup({ closedEntries: [entry] })
    fileSearch.resultPaths = ['/ws/other.ts']
    const picker = new FakeQuickPick<IQuickPickItem>()
    run(provider, picker)
    await flushPromises()

    expect(picker.items.map((i) => (i as IQuickPickItem).label)).not.toContain('a.term')
  })

  it('only the newest of several closed entries for one resource is listed', async () => {
    const uri = URI.file('/ws/pic.png')
    // getClosedEditors() returns newest-first; both entries share the resource.
    const { provider, fileSearch } = setup({
      closedEntries: [closedEntry(uri, 1, 'pic-old'), closedEntry(uri, 1, 'pic-new')],
    })
    fileSearch.resultPaths = ['/ws/other.ts']
    const picker = new FakeQuickPick<IQuickPickItem>()
    run(provider, picker)
    await flushPromises()

    expect(picker.items.map((i) => (i as IQuickPickItem).label)).toContain('pic-new')
    expect(picker.items.map((i) => (i as IQuickPickItem).label)).not.toContain('pic-old')
  })

  it('reopening a just-closed file restores the exact editor type instead of re-resolving', async () => {
    const uri = URI.file('/ws/doc.pdf')
    const { provider, fileSearch, resolver, groupsFake, closedEditors } = setup({
      closedEntries: [closedEntry(uri)],
    })
    fileSearch.resultPaths = ['/ws/doc.pdf']
    const picker = new FakeQuickPick<IQuickPickItem>()
    run(provider, picker)
    await flushPromises()

    picker.fireValue('doc')
    picker.fireAccept([picker.items[0] as IQuickPickItem])

    expect(closedEditors.takeCalls.map((u) => u.toString())).toEqual([uri.toString()])
    expect(groupsFake.openLog).toHaveLength(1)
    expect(groupsFake.openLog[0]!.groupId).toBe(1)
    expect(groupsFake.openLog[0]!.editor.typeId).toBe(FAKE_CUSTOM_TYPE)
    expect(groupsFake.openLog[0]!.editor.resource?.toString()).toBe(uri.toString())
    expect(groupsFake.openLog[0]!.options).toMatchObject({ activate: true, pinned: true })
    expect(resolver.opened).toHaveLength(0)
  })

  it('restores the closed image type even while the same file stays open as text', async () => {
    const uri = URI.file('/ws/pic.png')
    const textEditor = new FakeEditorInput('file', uri, 'pic.png')
    const { provider, resolver, groupsFake, closedEditors } = setup({
      openEditors: [textEditor],
      closedEntries: [closedEntry(uri, 1, 'pic.png')],
    })
    const picker = new FakeQuickPick<IQuickPickItem>()
    run(provider, picker)
    await flushPromises()

    // The pick id collides with the open text tab's — one row is listed, but
    // accepting it restores the closed editor type (closed-first), it does not
    // merely activate the surviving text tab.
    expect(picker.items.map((i) => (i as IQuickPickItem).label)).toEqual(['pic.png'])
    picker.fireAccept([picker.items[0] as IQuickPickItem])

    expect(closedEditors.takeCalls).toHaveLength(1)
    expect(groupsFake.openLog).toHaveLength(1)
    expect(groupsFake.openLog[0]!.editor.typeId).toBe(FAKE_CUSTOM_TYPE)
    expect(groupsFake.setActiveLog).toHaveLength(0)
    expect(resolver.opened).toHaveLength(0)
  })

  it('falls back to the resolver when the closed entry cannot be deserialized', async () => {
    const uri = URI.file('/ws/doc.pdf')
    const entry: ClosedEditorEntry = {
      resource: uri,
      typeId: 'fake.unregistered.quickopen.test',
      groupId: 1,
      serializedData: null,
      label: 'doc.pdf',
    }
    const { provider, fileSearch, resolver, groupsFake } = setup({ closedEntries: [entry] })
    fileSearch.resultPaths = ['/ws/doc.pdf']
    const picker = new FakeQuickPick<IQuickPickItem>()
    run(provider, picker)
    await flushPromises()

    picker.fireValue('doc')
    picker.fireAccept([picker.items[0] as IQuickPickItem])

    expect(groupsFake.openLog).toHaveLength(0)
    expect(resolver.opened).toHaveLength(1)
    expect(resolver.opened[0]!.uri.toString()).toBe(uri.toString())
  })

  it('a virtual-scheme pick with no restorable closed entry never falls back to the resolver', async () => {
    // Restart-shaped scenario: a stale universe:/acp/session/<guid> entry
    // (e.g. from a persisted list) is accepted while the closed stack has
    // nothing for it. Resolving it would fabricate an empty FileEditorInput
    // tab labelled with the raw guid — the exact bug this guards against.
    const uri = URI.parse('universe:/acp/session/3f2a-guid')
    const recent: IRecentFile[] = [{ uri, name: 'My Session', lastOpened: 1 }]
    const { provider, fileSearch, resolver, groupsFake } = setup({ recent })
    fileSearch.resultPaths = ['/ws/other.ts']
    const picker = new FakeQuickPick<IQuickPickItem>()
    run(provider, picker)
    await flushPromises()

    const pick = picker.items.find((i) => (i as IQuickPickItem).label === 'My Session')
    expect(pick).toBeDefined()
    picker.fireAccept([pick as IQuickPickItem])

    expect(resolver.opened).toHaveLength(0)
    expect(groupsFake.openLog).toHaveLength(0)
    expect(groupsFake.setActiveLog).toHaveLength(0)
  })

  it('a virtual-scheme closed entry that fails to deserialize does not fall back to the resolver', async () => {
    const uri = URI.parse('universe:/gitGraph')
    const entry: ClosedEditorEntry = {
      resource: uri,
      typeId: FAKE_CUSTOM_TYPE,
      groupId: 1,
      serializedData: { poison: true },
      label: 'Git Graph',
    }
    const { provider, fileSearch, resolver, groupsFake, closedEditors } = setup({
      closedEntries: [entry],
    })
    // The poisoned payload lacks `resource`, so the provider deserializes to
    // null: the restore path fails after consuming the entry — the resolver
    // must still not run for a virtual-scheme URI.
    fileSearch.resultPaths = ['/ws/other.ts']
    const picker = new FakeQuickPick<IQuickPickItem>()
    run(provider, picker)
    await flushPromises()

    const pick = picker.items.find((i) => (i as IQuickPickItem).label === 'Git Graph')
    expect(pick).toBeDefined()
    picker.fireAccept([pick as IQuickPickItem])

    expect(closedEditors.takeCalls).toHaveLength(1)
    expect(resolver.opened).toHaveLength(0)
    expect(groupsFake.openLog).toHaveLength(0)
  })

  it('restores into the active group when the entry group no longer exists', async () => {
    const uri = URI.file('/ws/doc.pdf')
    const { provider, fileSearch, groupsFake } = setup({
      closedEntries: [closedEntry(uri, 999)],
    })
    fileSearch.resultPaths = ['/ws/doc.pdf']
    const picker = new FakeQuickPick<IQuickPickItem>()
    run(provider, picker)
    await flushPromises()

    picker.fireValue('doc')
    picker.fireAccept([picker.items[0] as IQuickPickItem])

    expect(groupsFake.openLog).toHaveLength(1)
    expect(groupsFake.openLog[0]!.groupId).toBe(1)
    expect(groupsFake.activatedGroupIds).toEqual([1])
  })

  it('with no workspace, closed entries are listed and restore with pinned: false', async () => {
    const uri = URI.file('/home/doc.pdf')
    const { provider, groupsFake } = setup({
      root: null,
      closedEntries: [closedEntry(uri, 1, 'doc.pdf')],
    })
    const picker = new FakeQuickPick<IQuickPickItem>()
    run(provider, picker)
    await flushPromises()

    expect(picker.items.map((i) => (i as IQuickPickItem).label)).toContain('doc.pdf')

    const docPick = picker.items.find(
      (i) => (i as IQuickPickItem).label === 'doc.pdf',
    ) as IQuickPickItem
    picker.fireAccept([docPick])

    expect(groupsFake.openLog).toHaveLength(1)
    expect(groupsFake.openLog[0]!.editor.typeId).toBe(FAKE_CUSTOM_TYPE)
    expect(groupsFake.openLog[0]!.options).toMatchObject({ activate: true, pinned: false })
  })

  it('ctrl+accept restores the closed editor into the side group', async () => {
    const uri = URI.file('/ws/doc.pdf')
    const { provider, fileSearch, resolver, groupsFake, closedEditors } = setup({
      closedEntries: [closedEntry(uri)],
    })
    fileSearch.resultPaths = ['/ws/doc.pdf']
    const picker = new FakeQuickPick<IQuickPickItem>()
    picker.keyMods = { ctrl: true, alt: false }
    run(provider, picker)
    await flushPromises()

    picker.fireValue('doc')
    picker.fireAccept([picker.items[0] as IQuickPickItem])

    // A new side group was created and received the restored editor.
    expect(closedEditors.takeCalls).toHaveLength(1)
    expect(groupsFake.all).toHaveLength(2)
    expect(groupsFake.openLog).toHaveLength(1)
    expect(groupsFake.openLog[0]!.groupId).toBe(2)
    expect(groupsFake.openLog[0]!.editor.typeId).toBe(FAKE_CUSTOM_TYPE)
    expect(groupsFake.openLog[0]!.options).toMatchObject({ activate: true, pinned: true })
    expect(resolver.opened).toHaveLength(0)
  })
})
