/*---------------------------------------------------------------------------------------------
 *  Tests for SearchView watcher + workspace switch interactions.
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
import { resetSearchSession } from '../searchSession.js'

class FakeTextSearch implements ITextSearchServiceType {
  declare readonly _serviceBrand: undefined
  results: readonly IFileMatch[] = []
  async search(
    _query: ITextSearchQuery,
    opts?: ITextSearchOptions,
  ): Promise<readonly IFileMatch[]> {
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
  services.set(IEditorService, new FakeEditorService() as never)
  services.set(IStatusBarService, new FakeStatusBar() as never)
  services.set(IFileService, stubFile as never)
  services.set(IFileWatcherService, watcher as never)
  services.set(IWorkspaceService, workspace as never)
  const inst = new InstantiationService(services)
  services.set(IInstantiationService, inst)
  return {
    watcherEmitter,
    workspaceEmitter,
    rendered: render(
      <ServicesContext.Provider value={inst}>
        <SearchView />
      </ServicesContext.Provider>,
    ),
  }
}

function makeFileMatch(path: string): IFileMatch {
  return {
    resource: URI.file(path).toJSON(),
    matches: [{ lineNumber: 1, preview: 'foo', ranges: [{ startColumn: 1, endColumn: 4 }] }],
  }
}

async function runQuery(search: FakeTextSearch) {
  const input = screen.getByLabelText('Search') as HTMLInputElement
  act(() => {
    fireEvent.change(input, { target: { value: 'foo' } })
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(260)
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
      ctx.watcherEmitter.fire([{ type: 'modified', resource: URI.file('/ws/a.ts').toJSON() }])
    })
    expect(screen.queryByTestId('search-stale')).toBeTruthy()
  })

  it('does not mark stale when an unrelated file changes', async () => {
    const search = new FakeTextSearch()
    search.results = [makeFileMatch('/ws/a.ts')]
    const ctx = renderWithServices(search)
    await runQuery(search)
    act(() => {
      ctx.watcherEmitter.fire([{ type: 'modified', resource: URI.file('/ws/other.ts').toJSON() }])
    })
    expect(screen.queryByTestId('search-stale')).toBeNull()
  })

  it('clears results when the workspace changes', async () => {
    const search = new FakeTextSearch()
    search.results = [makeFileMatch('/ws/a.ts')]
    const ctx = renderWithServices(search)
    await runQuery(search)
    expect(screen.queryByText(/匹配/)).toBeTruthy()
    act(() => {
      ctx.workspaceEmitter.fire(null)
    })
    expect(screen.queryByText(/匹配/)).toBeFalsy()
  })
})
