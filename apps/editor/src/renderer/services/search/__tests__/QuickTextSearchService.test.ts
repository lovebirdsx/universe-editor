/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/search/QuickTextSearchService.ts
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  Emitter,
  Event,
  IFileService,
  IInstantiationService,
  InstantiationService,
  ServiceCollection,
  URI,
  UriIdentityService,
  type Event as IEvent,
  type IFileMatch,
  type IInputOptions,
  type IPickOptions,
  type IQuickInputService,
  type IQuickInputButton,
  type IQuickPick,
  type IQuickPickItem,
  type QuickPickInput,
  type QuickPickPresentation,
  type ITextSearchOptions,
  type ITextSearchQuery,
  type ITextSearchService,
  type IWorkspace,
  type IWorkspaceService,
} from '@universe-editor/platform'
import { EditorGroupsService } from '../../editor/EditorGroupsService.js'
import { FileEditorInput } from '../../editor/FileEditorInput.js'
import { FileEditorRegistry } from '../../editor/FileEditorRegistry.js'
import { QuickTextSearchService } from '../QuickTextSearchService.js'

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
  value = ''
  prefix = ''
  mruIds: readonly string[] = []
  filterExternally = false
  filterMode: 'fuzzy' | 'word' = 'fuzzy'
  matchOnDescription = false
  matchOnDetail = false
  presentation: QuickPickPresentation = 'default'
  busy = false
  shown = false

  show(): void {
    this.shown = true
  }

  hide(): void {
    if (!this.shown) return
    this.shown = false
    this._onDidHide.fire()
  }

  fireValue(value: string): void {
    this.value = value
    this._onDidChangeValue.fire(value)
  }

  accept(item: T): void {
    this._onDidAccept.fire([item])
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

class FakeQuickInputService implements IQuickInputService {
  declare readonly _serviceBrand: undefined
  picker: FakeQuickPick<IQuickPickItem> | undefined

  createQuickPick<T extends IQuickPickItem>(): IQuickPick<T> {
    const picker = new FakeQuickPick<T>()
    this.picker = picker as unknown as FakeQuickPick<IQuickPickItem>
    return picker
  }

  async pick<T extends IQuickPickItem>(
    _items: readonly QuickPickInput<T>[],
    _options?: IPickOptions,
  ): Promise<T | undefined> {
    return undefined
  }

  async input(_options?: IInputOptions): Promise<string | undefined> {
    return undefined
  }

  hide(): void {
    this.picker?.hide()
  }
}

class FakeTextSearchService implements ITextSearchService {
  declare readonly _serviceBrand: undefined
  readonly calls: Array<{ query: ITextSearchQuery; opts: ITextSearchOptions | undefined }> = []
  results: readonly IFileMatch[] = []
  deferred = false
  private readonly _resolvers: Array<(value: readonly IFileMatch[]) => void> = []

  async search(query: ITextSearchQuery, opts?: ITextSearchOptions): Promise<readonly IFileMatch[]> {
    this.calls.push({ query, opts })
    if (!this.deferred) return this.results
    return await new Promise<readonly IFileMatch[]>((resolve) => this._resolvers.push(resolve))
  }

  resolveAll(value: readonly IFileMatch[] = this.results): void {
    while (this._resolvers.length > 0) {
      this._resolvers.pop()?.(value)
    }
  }
}

class FakeWorkspaceService implements IWorkspaceService {
  declare readonly _serviceBrand: undefined
  readonly onDidChangeWorkspace: IEvent<IWorkspace | null> = Event.None
  readonly onDidChangeRecent: IEvent<readonly never[]> = Event.None
  readonly recent = [] as never[]
  readonly whenReady = Promise.resolve()

  constructor(readonly current: IWorkspace | null) {}

  async openFolder() {}
  async closeFolder() {}
  async clearRecent() {}
  async removeRecent() {}
}

function fakeFileService(): IFileService {
  return {
    _serviceBrand: undefined,
    async readFile() {
      return new Uint8Array()
    },
    async readFileText() {
      return ''
    },
    async writeFile() {},
    async exists() {
      return true
    },
    async stat(resource: URI) {
      return { resource, isFile: true, isDirectory: false, size: 0, mtime: 0 }
    },
    async list() {
      return []
    },
    async listRecursive() {
      return []
    },
    async createDirectory() {},
    async delete() {},
    async rename() {},
    async copy() {},
  }
}

function makeMatch(path: string, preview = 'const needle = true'): IFileMatch {
  return {
    resource: URI.file(path),
    matches: [
      {
        lineNumber: 3,
        preview,
        ranges: [{ startColumn: 7, endColumn: 13 }],
      },
    ],
  }
}

function flushPromises(): Promise<void> {
  return Promise.resolve().then(() => undefined)
}

function setup(root: URI | null = URI.file('/repo')) {
  const quickInput = new FakeQuickInputService()
  const textSearch = new FakeTextSearchService()
  const workspace = new FakeWorkspaceService(root ? { folder: root, name: 'repo' } : null)
  const groups = new EditorGroupsService()
  const services = new ServiceCollection()
  services.set(IFileService, fakeFileService())
  const instantiation = new InstantiationService(services)
  services.set(IInstantiationService, instantiation)
  const service = new QuickTextSearchService(
    quickInput,
    textSearch,
    workspace,
    groups,
    instantiation,
    new UriIdentityService('linux'),
  )
  return { service, quickInput, textSearch, workspace, groups, instantiation, root }
}

describe('QuickTextSearchService', () => {
  afterEach(() => {
    vi.useRealTimers()
    FileEditorRegistry._resetForTests()
  })

  it('searches after the VSCode quick-search debounce and renders match picks', async () => {
    vi.useFakeTimers()
    const { service, quickInput, textSearch } = setup()
    textSearch.results = [makeMatch('/repo/src/a.ts')]

    const promise = service.show()
    const picker = quickInput.picker!
    expect(picker.shown).toBe(true)
    expect(picker.filterExternally).toBe(true)
    expect(picker.presentation).toBe('compact')

    picker.fireValue('needle')
    await vi.advanceTimersByTimeAsync(74)
    expect(textSearch.calls).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(1)
    await flushPromises()

    expect(textSearch.calls).toHaveLength(1)
    expect(textSearch.calls[0]!.query).toMatchObject({
      pattern: 'needle',
      isRegex: false,
      matchCase: false,
      matchWholeWord: false,
      maxResults: 500,
      maxMatchesPerFile: 10,
    })
    expect(picker.items[0]).toMatchObject({
      type: 'separator',
      label: 'a.ts',
      description: 'src',
    })
    expect(picker.items[1]).toMatchObject({
      label: 'const needle = true',
      description: '3:7',
      highlights: { label: [{ start: 6, end: 12 }] },
    })

    picker.hide()
    await promise
  })

  it('cancels an in-flight search when the query changes', async () => {
    vi.useFakeTimers()
    const { service, quickInput, textSearch } = setup()
    textSearch.deferred = true

    const promise = service.show()
    const picker = quickInput.picker!

    picker.fireValue('first')
    await vi.advanceTimersByTimeAsync(75)
    expect(textSearch.calls).toHaveLength(1)
    const firstSignal = textSearch.calls[0]!.opts?.signal
    expect(firstSignal?.aborted).toBe(false)

    picker.fireValue('second')
    await vi.advanceTimersByTimeAsync(75)
    expect(textSearch.calls).toHaveLength(2)
    expect(firstSignal?.aborted).toBe(true)

    textSearch.resolveAll([])
    picker.hide()
    await promise
  })

  it('accepts a match by opening the file and revealing the selected range', async () => {
    vi.useFakeTimers()
    const { service, quickInput, textSearch, groups, instantiation } = setup()
    const resource = URI.file('/repo/src/a.ts')
    const input = instantiation.createInstance(FileEditorInput, resource)
    groups.activeGroup.openEditor(input, { activate: true, pinned: true })

    const fakeEditor = {
      getSelection: vi.fn(() => ({ isEmpty: () => true })),
      getModel: vi.fn(() => undefined),
      setSelection: vi.fn(),
      revealLineInCenter: vi.fn(),
      focus: vi.fn(),
    }
    FileEditorRegistry.register(input, fakeEditor as never, groups.activeGroup.id)
    textSearch.results = [makeMatch('/repo/src/a.ts')]

    const promise = service.show()
    const picker = quickInput.picker!
    picker.fireValue('needle')
    await vi.advanceTimersByTimeAsync(75)
    await flushPromises()

    const matchPick = picker.items.find((item) => item.label === 'const needle = true')
    expect(matchPick).toBeDefined()
    picker.accept(matchPick as IQuickPickItem)
    await promise

    expect(groups.activeGroup.activeEditor).toBe(input)
    expect(fakeEditor.setSelection).toHaveBeenCalledWith({
      startLineNumber: 3,
      startColumn: 7,
      endLineNumber: 3,
      endColumn: 13,
    })
    expect(fakeEditor.revealLineInCenter).toHaveBeenCalledWith(3)
    expect(fakeEditor.focus).toHaveBeenCalled()
  })

  it('seeds the query from the active editor selection', async () => {
    vi.useFakeTimers()
    const { service, quickInput, textSearch, groups, instantiation } = setup()
    const input = instantiation.createInstance(FileEditorInput, URI.file('/repo/src/a.ts'))
    groups.activeGroup.openEditor(input, { activate: true, pinned: true })
    FileEditorRegistry.register(
      input,
      {
        getSelection: vi.fn(() => ({ isEmpty: () => false })),
        getModel: vi.fn(() => ({ getValueInRange: () => 'selected text' })),
      } as never,
      groups.activeGroup.id,
    )

    const promise = service.show()
    const picker = quickInput.picker!
    expect(picker.value).toBe('selected text')

    await vi.advanceTimersByTimeAsync(75)
    await flushPromises()
    expect(textSearch.calls[0]?.query.pattern).toBe('selected text')

    picker.hide()
    await promise
  })

  it('shows a no-workspace message without calling search', async () => {
    const { service, quickInput, textSearch } = setup(null)

    const promise = service.show()
    const picker = quickInput.picker!

    expect(picker.items[0]?.label).toBe('Open a folder to search across files.')
    expect(textSearch.calls).toHaveLength(0)

    picker.hide()
    await promise
  })
})
