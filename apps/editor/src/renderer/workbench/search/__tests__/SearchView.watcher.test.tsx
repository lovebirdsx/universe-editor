/*---------------------------------------------------------------------------------------------
 *  Tests for SearchView watcher + workspace switch interactions.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  Emitter,
  IConfigurationService,
  IEditorService,
  IFileService,
  IFileWatcherService,
  IInstantiationService,
  IStatusBarService,
  ITextSearchService,
  IWorkspaceService,
  InstantiationService,
  ServiceCollection,
  URI,
  observableValue,
  type IEditorInput,
  type IFileChangeEvent,
  type IFileMatch,
  type IObservable,
  type IStatusBarEntryAccessor,
  type ITextSearchOptions,
  type ITextSearchQuery,
  type ITextSearchService as ITextSearchServiceType,
  type IWorkspace,
} from '@universe-editor/platform'
import { SearchView } from '../SearchView.js'
import { ServicesContext } from '../../useService.js'
import { resetSearchSession } from '../searchSession.js'
import { stubConfigurationService } from './stubConfigurationService.js'

class FakeTextSearch implements ITextSearchServiceType {
  declare readonly _serviceBrand: undefined
  results: readonly IFileMatch[] = []
  searchCalls = 0
  /** When set, emit these batches via onResults before resolving. */
  batches: readonly (readonly IFileMatch[])[] | undefined
  /** Delay between emitted batches, so each lands past the 80ms result-flush timer. */
  batchDelayMs = 0
  async search(
    _query: ITextSearchQuery,
    opts?: ITextSearchOptions,
  ): Promise<readonly IFileMatch[]> {
    this.searchCalls++
    if (opts?.signal?.aborted) return []
    if (this.batches) {
      for (const batch of this.batches) {
        if (opts?.signal?.aborted) return []
        opts?.onResults?.(batch)
        if (this.batchDelayMs > 0) {
          await new Promise((r) => setTimeout(r, this.batchDelayMs))
        }
      }
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
  activeEditor: IObservable<IEditorInput | null> = observableValue<IEditorInput | null>(
    'fake.activeEditor',
    null,
  )
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
  addEntry(_entry: { text: string }): IStatusBarEntryAccessor {
    return { update: () => {}, dispose: () => {} }
  }
  entries$ = observableValue<readonly never[]>('fake.entries', [])
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

function renderWithServices(search: FakeTextSearch) {
  const services = new ServiceCollection()
  const watcherEmitter = new Emitter<readonly IFileChangeEvent[]>()
  const workspaceEmitter = new Emitter<IWorkspace | null>()
  let watcherSubscriptions = 0
  const watcher = {
    _serviceBrand: undefined,
    onDidChangeFiles: ((listener: (e: readonly IFileChangeEvent[]) => unknown) => {
      watcherSubscriptions++
      return watcherEmitter.event(listener)
    }) as typeof watcherEmitter.event,
    watch: async () => {},
    unwatch: async () => {},
  }
  const workspace = {
    _serviceBrand: undefined,
    current: null as IWorkspace | null,
    recent: [],
    onDidChangeWorkspace: workspaceEmitter.event,
    onDidChangeRecent: new Emitter<readonly never[]>().event,
    openFolder: async () => {},
    closeFolder: async () => {},
    clearRecent: async () => {},
  }
  services.set(ITextSearchService, search)
  services.set(IEditorService, new FakeEditorService() as never)
  services.set(IStatusBarService, new FakeStatusBar() as never)
  services.set(IFileService, stubFile as never)
  services.set(IFileWatcherService, watcher as never)
  services.set(IWorkspaceService, workspace as never)
  services.set(IConfigurationService, stubConfigurationService())
  const inst = new InstantiationService(services)
  services.set(IInstantiationService, inst)
  return {
    inst,
    watcherEmitter,
    workspaceEmitter,
    workspace,
    get watcherSubscriptionCount() {
      return watcherSubscriptions
    },
    rendered: render(
      <ServicesContext.Provider value={inst}>
        <SearchView />
      </ServicesContext.Provider>,
    ),
  }
}

function makeFileMatch(path: string): IFileMatch {
  return {
    resource: URI.file(path),
    matches: [{ lineNumber: 1, preview: 'foo', ranges: [{ startColumn: 1, endColumn: 4 }] }],
  }
}

async function runQuery(search: FakeTextSearch) {
  const input = screen.getByLabelText('Search') as HTMLInputElement
  act(() => {
    fireEvent.change(input, { target: { value: 'foo' } })
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400)
  })
  void search
}

describe('SearchView watcher + workspace', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetSearchSession()
  })

  afterEach(() => {
    vi.useRealTimers()
    cleanup()
  })

  it('shows the stale banner when a result file changes on disk', async () => {
    const search = new FakeTextSearch()
    search.results = [makeFileMatch('/ws/a.ts')]
    const ctx = renderWithServices(search)
    await runQuery(search)
    expect(screen.queryByTestId('search-stale')).toBeNull()
    act(() => {
      ctx.watcherEmitter.fire([{ type: 'modified', resource: URI.file('/ws/a.ts') }])
    })
    expect(screen.queryByTestId('search-stale')).toBeTruthy()
  })

  it('does not mark stale when an unrelated file changes', async () => {
    const search = new FakeTextSearch()
    search.results = [makeFileMatch('/ws/a.ts')]
    const ctx = renderWithServices(search)
    await runQuery(search)
    act(() => {
      ctx.watcherEmitter.fire([{ type: 'modified', resource: URI.file('/ws/other.ts') }])
    })
    expect(screen.queryByTestId('search-stale')).toBeNull()
  })

  it('clears results then re-runs the search when the workspace changes', async () => {
    const search = new FakeTextSearch()
    search.results = [makeFileMatch('/ws/a.ts')]
    const ctx = renderWithServices(search)
    await runQuery(search)
    expect(screen.queryByText(/matches/)).toBeTruthy()
    expect(search.searchCalls).toBe(1)
    act(() => {
      ctx.workspaceEmitter.fire(null)
    })
    // Results from the old workspace drop immediately…
    expect(screen.queryByText(/matches/)).toBeFalsy()
    // …then the current query re-runs against the new workspace after the debounce.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })
    expect(search.searchCalls).toBe(2)
    expect(screen.queryByText(/matches/)).toBeTruthy()
  })

  it('re-runs the search on remount when the workspace changed while unmounted', async () => {
    const search = new FakeTextSearch()
    search.results = [makeFileMatch('/ws/a.ts')]
    const ctx = renderWithServices(search)
    await runQuery(search)
    expect(search.searchCalls).toBe(1)

    // Sidebar switch away (unmount), workspace changes while the view is gone.
    ctx.rendered.unmount()
    act(() => {
      ctx.workspace.current = { folder: URI.file('/ws2'), name: 'ws2' }
      ctx.workspaceEmitter.fire(ctx.workspace.current)
    })
    render(
      <ServicesContext.Provider value={ctx.inst}>
        <SearchView />
      </ServicesContext.Provider>,
    )
    // Cached results belong to the old workspace: the remount must not reuse
    // them silently — the query re-runs after the debounce.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })
    expect(search.searchCalls).toBe(2)
  })

  it('subscribes to the file watcher once while results stream in', async () => {
    const search = new FakeTextSearch()
    const a = makeFileMatch('/ws/a.ts')
    const b = makeFileMatch('/ws/b.ts')
    const c = makeFileMatch('/ws/c.ts')
    search.batches = [[a], [b], [c]]
    search.batchDelayMs = 100
    search.results = [a, b, c]
    const ctx = renderWithServices(search)
    await runQuery(search)
    // Drain the remaining batches across the 80ms flush timer so `results` state
    // changes several times; the watcher must stay subscribed exactly once.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300)
    })
    expect(ctx.watcherSubscriptionCount).toBe(1)
    act(() => {
      ctx.watcherEmitter.fire([{ type: 'modified', resource: URI.file('/ws/a.ts') }])
    })
    expect(screen.queryByTestId('search-stale')).toBeTruthy()
  })
})
