/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/workbench/search/SearchView.tsx
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  Emitter,
  IConfigurationService,
  IEditorService,
  IFileService,
  IFileWatcherService,
  IFocusableRegistry,
  IInstantiationService,
  IStatusBarService,
  ITextSearchService,
  IUriIdentityService,
  IWorkspaceService,
  InstantiationService,
  ServiceCollection,
  URI,
  UriIdentityService,
  observableValue,
  type IEditorInput,
  type IFileChangeEvent,
  type IFileMatch,
  type IObservable,
  type IStatusBarEntryAccessor,
  type ITextSearchOptions,
  type ITextSearchQuery,
  type ITextSearchService as ITextSearchServiceType,
  type HostPlatform,
  type IWorkspace,
} from '@universe-editor/platform'
import { SearchView } from '../SearchView.js'
import { ServicesContext } from '../../useService.js'
import { resetSearchSession, searchSession } from '../searchSession.js'
import { searchViewState } from '../searchViewState.js'
import { FileEditorInput } from '../../../services/editor/FileEditorInput.js'
import { FocusableRegistry } from '../../../services/focus/FocusableRegistry.js'
import { stubConfigurationService } from './stubConfigurationService.js'

class FakeTextSearch implements ITextSearchServiceType {
  declare readonly _serviceBrand: undefined
  results: readonly IFileMatch[] = []
  searchCalls = 0
  lastSignal: AbortSignal | undefined
  delayMs = 0
  /** When set, emit these batches via onResults before resolving (incremental). */
  batches: readonly (readonly IFileMatch[])[] | undefined
  async search(
    _query: ITextSearchQuery,
    opts?: ITextSearchOptions,
  ): Promise<readonly IFileMatch[]> {
    this.searchCalls++
    this.lastSignal = opts?.signal
    if (this.batches) {
      for (const batch of this.batches) {
        if (opts?.signal?.aborted) return []
        opts?.onResults?.(batch)
      }
    }
    if (this.delayMs > 0) {
      await new Promise((r) => setTimeout(r, this.delayMs))
    }
    if (opts?.signal?.aborted) return []
    opts?.onProgress?.({ filesScanned: 1, filesMatched: this.results.length, totalMatches: 1 })
    return this.results
  }
}

class FakeEditorService {
  declare readonly _serviceBrand: undefined
  opened: IEditorInput[] = []
  openEditors: IObservable<readonly IEditorInput[]> = observableValue<readonly IEditorInput[]>(
    'fake.openEditors',
    [],
  )
  activeEditor = observableValue<IEditorInput | null>('fake.activeEditor', null)
  openEditor(input: IEditorInput): void {
    this.opened.push(input)
  }
  closeEditor(): void {}
  saveEditor(): Promise<boolean> {
    return Promise.resolve(true)
  }
  saveAllEditors(): Promise<boolean> {
    return Promise.resolve(true)
  }
}

class FakeStatusBar {
  declare readonly _serviceBrand: undefined
  entries: { text: string; disposed: boolean }[] = []
  addEntry(entry: { text: string }): IStatusBarEntryAccessor {
    const rec = { text: entry.text, disposed: false }
    this.entries.push(rec)
    return {
      update: (e) => {
        rec.text = e.text
      },
      dispose: () => {
        rec.disposed = true
      },
    }
  }
  entries$ = observableValue<readonly never[]>('fake.entries', [])
  get entries_obs() {
    return this.entries$
  }
}

const stubFile = {
  _serviceBrand: undefined,
  async readFile() {
    return new Uint8Array()
  },
  async readFileText() {
    return ''
  },
  async writeFile() {},
  async exists() {
    return false
  },
  async stat() {
    throw new Error('not used')
  },
  async list() {
    return []
  },
  async createDirectory() {},
  async delete() {},
  async rename() {},
}

function renderWithServices(
  search: FakeTextSearch,
  config: Record<string, unknown> = {},
  platform: HostPlatform = 'linux',
) {
  const services = new ServiceCollection()
  const editor = new FakeEditorService()
  const status = new FakeStatusBar()
  const registry = new FocusableRegistry()
  const watcherEmitter = new Emitter<readonly IFileChangeEvent[]>()
  const workspaceEmitter = new Emitter<IWorkspace | null>()
  const watcher = {
    _serviceBrand: undefined,
    onDidChangeFiles: watcherEmitter.event,
    watch: async () => {},
    unwatch: async () => {},
  }
  const workspace = {
    _serviceBrand: undefined,
    current: null,
    recent: [],
    onDidChangeWorkspace: workspaceEmitter.event,
    onDidChangeRecent: new Emitter<readonly never[]>().event,
    openFolder: async () => {},
    closeFolder: async () => {},
    clearRecent: async () => {},
  }
  services.set(ITextSearchService, search)
  services.set(IEditorService, editor as never)
  services.set(IStatusBarService, status as never)
  services.set(IFileService, stubFile as never)
  services.set(IFileWatcherService, watcher as never)
  services.set(IWorkspaceService, workspace as never)
  services.set(IConfigurationService, stubConfigurationService(config))
  services.set(IUriIdentityService, new UriIdentityService(platform))
  services.set(IFocusableRegistry, registry)
  const inst = new InstantiationService(services)
  services.set(IInstantiationService, inst)
  return {
    inst,
    editor,
    status,
    registry,
    watcherEmitter,
    workspaceEmitter,
    rendered: render(
      <ServicesContext.Provider value={inst}>
        <SearchView />
      </ServicesContext.Provider>,
    ),
  }
}

function makeFileMatch(path: string, line: number, preview: string): IFileMatch {
  return {
    resource: URI.file(path),
    matches: [{ lineNumber: line, preview, ranges: [{ startColumn: 1, endColumn: 4 }] }],
  }
}

// Just past search.searchOnTypeDebouncePeriod (300ms), so one tick of this length
// fires the debounced search without also draining the 80ms result-flush timer.
const PAST_DEBOUNCE_MS = 320

describe('SearchView', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetSearchSession()
    searchViewState.setViewMode('list')
    searchViewState.setHasResults(false)
  })

  afterEach(() => {
    vi.useRealTimers()
    cleanup()
  })

  it('debounces input changes — a single search after the debounce period', async () => {
    const search = new FakeTextSearch()
    search.results = [makeFileMatch('/ws/a.ts', 1, 'foo bar')]
    renderWithServices(search)
    const input = screen.getByLabelText('Search') as HTMLInputElement
    act(() => {
      fireEvent.change(input, { target: { value: 'f' } })
    })
    act(() => {
      fireEvent.change(input, { target: { value: 'fo' } })
    })
    act(() => {
      fireEvent.change(input, { target: { value: 'foo' } })
    })
    expect(search.searchCalls).toBe(0)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PAST_DEBOUNCE_MS)
    })
    expect(search.searchCalls).toBe(1)
  })

  it('renders incremental batches before the search resolves', async () => {
    const search = new FakeTextSearch()
    // The search resolves slowly, but batches stream in immediately. The tree
    // must show the batched files before the promise settles.
    search.delayMs = 1000
    const early = makeFileMatch('/ws/early.ts', 1, 'foo early')
    search.batches = [[early]]
    search.results = [early, makeFileMatch('/ws/late.ts', 2, 'foo late')]
    renderWithServices(search)
    const input = screen.getByLabelText('Search') as HTMLInputElement
    act(() => {
      fireEvent.change(input, { target: { value: 'foo' } })
    })
    // Fire the debounce → runSearch → onResults batch → 80ms flush timer.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PAST_DEBOUNCE_MS)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    // early.ts is visible from the incremental batch, before the 1000ms resolve.
    expect(screen.getByText('early.ts')).toBeTruthy()
    expect(screen.queryByText('late.ts')).toBeFalsy()
    // After the search resolves, the authoritative full result set replaces it.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(screen.getByText('early.ts')).toBeTruthy()
    expect(screen.getByText('late.ts')).toBeTruthy()
  })

  it('clears results when the query is emptied', async () => {
    const search = new FakeTextSearch()
    search.results = [makeFileMatch('/ws/a.ts', 1, 'foo bar')]
    renderWithServices(search)
    const input = screen.getByLabelText('Search') as HTMLInputElement
    act(() => {
      fireEvent.change(input, { target: { value: 'foo' } })
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PAST_DEBOUNCE_MS)
    })
    expect(screen.queryByText(/matches/)).toBeTruthy()
    act(() => {
      fireEvent.change(input, { target: { value: '' } })
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PAST_DEBOUNCE_MS)
    })
    expect(screen.queryByText(/matches/)).toBeFalsy()
  })

  it('cancels a previous search when input changes mid-flight', async () => {
    const search = new FakeTextSearch()
    search.delayMs = 1000
    search.results = []
    renderWithServices(search)
    const input = screen.getByLabelText('Search') as HTMLInputElement
    act(() => {
      fireEvent.change(input, { target: { value: 'foo' } })
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PAST_DEBOUNCE_MS)
    })
    const firstSignal = search.lastSignal
    act(() => {
      fireEvent.change(input, { target: { value: 'foobar' } })
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PAST_DEBOUNCE_MS)
    })
    expect(firstSignal?.aborted).toBe(true)
  })

  it('mounts a status bar entry while searching and disposes it on completion', async () => {
    const search = new FakeTextSearch()
    search.delayMs = 50
    search.results = []
    const ctx = renderWithServices(search)
    const input = screen.getByLabelText('Search') as HTMLInputElement
    act(() => {
      fireEvent.change(input, { target: { value: 'foo' } })
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PAST_DEBOUNCE_MS)
    })
    expect(ctx.status.entries.length).toBeGreaterThan(0)
    expect(ctx.status.entries[0]?.disposed).toBe(false)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(ctx.status.entries[0]?.disposed).toBe(true)
  })

  it('restores query and results after unmount + remount (sidebar switch)', async () => {
    const search = new FakeTextSearch()
    search.results = [makeFileMatch('/ws/a.ts', 1, 'foo bar')]
    const ctx = renderWithServices(search)
    const input = screen.getByLabelText('Search') as HTMLInputElement
    act(() => {
      fireEvent.change(input, { target: { value: 'foo' } })
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PAST_DEBOUNCE_MS)
    })
    expect(search.searchCalls).toBe(1)
    expect(screen.getByText('a.ts')).toBeTruthy()

    // Switch away (unmount) then back (remount) with the same container.
    ctx.rendered.unmount()
    const before = search.searchCalls
    render(
      <ServicesContext.Provider value={ctx.inst}>
        <SearchView />
      </ServicesContext.Provider>,
    )
    const restored = screen.getByLabelText('Search') as HTMLInputElement
    expect(restored.value).toBe('foo')
    expect(screen.getByText('a.ts')).toBeTruthy()
    // Cached results are reused — no redundant search on remount.
    expect(search.searchCalls).toBe(before)
  })

  it('toggles match-case option and reruns the search', async () => {
    const search = new FakeTextSearch()
    renderWithServices(search)
    const input = screen.getByLabelText('Search') as HTMLInputElement
    act(() => {
      fireEvent.change(input, { target: { value: 'foo' } })
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PAST_DEBOUNCE_MS)
    })
    const before = search.searchCalls
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Match Case' }))
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PAST_DEBOUNCE_MS)
    })
    expect(search.searchCalls).toBeGreaterThan(before)
  })

  describe('focus target', () => {
    const VIEW_ID = 'workbench.view.search.results'

    async function renderWithResult(opts: { path?: string; platform?: HostPlatform } = {}) {
      const path = opts.path ?? '/ws/a.ts'
      const search = new FakeTextSearch()
      search.results = [makeFileMatch(path, 1, 'foo bar')]
      const ctx = renderWithServices(search, {}, opts.platform ?? 'linux')
      const input = screen.getByLabelText('Search') as HTMLInputElement
      act(() => {
        fireEvent.change(input, { target: { value: 'foo' } })
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(PAST_DEBOUNCE_MS)
      })
      expect(screen.getByText(path.split('/').pop()!)).toBeTruthy()
      return { ...ctx, input }
    }

    it('returns the tree container for the last activated match, not the ViewBody fallback', async () => {
      const ctx = await renderWithResult()
      const resource = URI.file('/ws/a.ts')
      const matchId = `match:${resource.toString()}:0`
      const active = ctx.inst.createInstance(FileEditorInput, resource)
      ctx.editor.activeEditor.set(active, undefined)
      searchSession.lastActivatedFocusId = matchId
      // Registered by every real ViewBody; a primary that resolves to null would
      // make FocusableRegistry hand this element back instead of the tree.
      const fallback = document.createElement('div')
      document.body.appendChild(fallback)
      ctx.registry.register(VIEW_ID, () => fallback, { fallback: true })

      const tree = screen.getByRole('tree', { name: 'Search results' })
      let focused: unknown = null
      act(() => {
        focused = ctx.registry.get(VIEW_ID)!()
      })

      expect(focused).toBe(tree)
      expect(document.activeElement).toBe(tree)
      expect(
        document
          .querySelector('[role="treeitem"][aria-selected="true"]')
          ?.getAttribute('data-row-key'),
      ).toBe(matchId)
      active.dispose()
      fallback.remove()
    })

    it('matches the active editor to a result whose path only differs in case', async () => {
      // The node id must be built from the *result's* URI: on a case-insensitive
      // platform the editor's and the result's spellings compare equal, but only
      // one of them names an existing tree node.
      const ctx = await renderWithResult({ path: '/ws/A.ts', platform: 'win32' })
      const active = ctx.inst.createInstance(FileEditorInput, URI.file('/ws/a.ts'))
      ctx.editor.activeEditor.set(active, undefined)
      const matchId = `match:${URI.file('/ws/A.ts').toString()}:0`
      searchSession.lastActivatedFocusId = matchId

      let focused: unknown = null
      act(() => {
        focused = ctx.registry.get(VIEW_ID)!()
      })

      expect(focused).toBe(screen.getByRole('tree', { name: 'Search results' }))
      expect(
        document
          .querySelector('[role="treeitem"][aria-selected="true"]')
          ?.getAttribute('data-row-key'),
      ).toBe(matchId)
      active.dispose()
    })

    it('falls back to the query input when the active editor is not in the results', async () => {
      const ctx = await renderWithResult()
      const active = ctx.inst.createInstance(FileEditorInput, URI.file('/ws/other.ts'))
      ctx.editor.activeEditor.set(active, undefined)
      searchSession.lastActivatedFocusId = `match:${URI.file('/ws/a.ts').toString()}:0`

      let focused: unknown = null
      act(() => {
        focused = ctx.registry.get(VIEW_ID)!()
      })

      expect(focused).toBe(ctx.input)
      active.dispose()
    })
  })
})
