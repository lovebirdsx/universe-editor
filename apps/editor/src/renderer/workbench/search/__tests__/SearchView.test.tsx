/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/workbench/search/SearchView.tsx
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import {
  Emitter,
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

class FakeTextSearch implements ITextSearchServiceType {
  declare readonly _serviceBrand: undefined
  results: readonly IFileMatch[] = []
  searchCalls = 0
  lastSignal: AbortSignal | undefined
  delayMs = 0
  async search(
    _query: ITextSearchQuery,
    opts?: ITextSearchOptions,
  ): Promise<readonly IFileMatch[]> {
    this.searchCalls++
    this.lastSignal = opts?.signal
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

function renderWithServices(search: FakeTextSearch) {
  const services = new ServiceCollection()
  const editor = new FakeEditorService()
  const status = new FakeStatusBar()
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
  const inst = new InstantiationService(services)
  services.set(IInstantiationService, inst)
  return {
    inst,
    editor,
    status,
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
    resource: URI.file(path).toJSON(),
    matches: [{ lineNumber: line, preview, ranges: [{ startColumn: 1, endColumn: 4 }] }],
  }
}

describe('SearchView', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    cleanup()
  })

  it('debounces input changes — single search after 250ms', async () => {
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
      await vi.advanceTimersByTimeAsync(260)
    })
    expect(search.searchCalls).toBe(1)
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
      await vi.advanceTimersByTimeAsync(260)
    })
    expect(screen.queryByText(/匹配/)).toBeTruthy()
    act(() => {
      fireEvent.change(input, { target: { value: '' } })
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(260)
    })
    expect(screen.queryByText(/匹配/)).toBeFalsy()
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
      await vi.advanceTimersByTimeAsync(260)
    })
    const firstSignal = search.lastSignal
    act(() => {
      fireEvent.change(input, { target: { value: 'foobar' } })
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(260)
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
      await vi.advanceTimersByTimeAsync(260)
    })
    expect(ctx.status.entries.length).toBeGreaterThan(0)
    expect(ctx.status.entries[0]?.disposed).toBe(false)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(ctx.status.entries[0]?.disposed).toBe(true)
  })

  it('toggles match-case option and reruns the search', async () => {
    const search = new FakeTextSearch()
    renderWithServices(search)
    const input = screen.getByLabelText('Search') as HTMLInputElement
    act(() => {
      fireEvent.change(input, { target: { value: 'foo' } })
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(260)
    })
    const before = search.searchCalls
    act(() => {
      fireEvent.click(screen.getByTitle('Match Case'))
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(260)
    })
    expect(search.searchCalls).toBeGreaterThan(before)
  })
})
