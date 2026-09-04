/*---------------------------------------------------------------------------------------------
 *  Tests for SearchViewToolbar enablement: Refresh/Clear follow query presence,
 *  Collapse All follows result presence.
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
import { SearchViewToolbar } from '../SearchViewToolbar.js'
import { ServicesContext } from '../../useService.js'
import { resetSearchSession } from '../searchSession.js'
import { searchViewState } from '../searchViewState.js'
import { stubConfigurationService } from './stubConfigurationService.js'

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

function renderViewWithToolbar(search: FakeTextSearch) {
  const services = new ServiceCollection()
  const watcherEmitter = new Emitter<readonly IFileChangeEvent[]>()
  const watcher = {
    _serviceBrand: undefined,
    onDidChangeFiles: watcherEmitter.event,
    watch: async () => {},
    unwatch: async () => {},
  }
  const workspace = {
    _serviceBrand: undefined,
    current: null as IWorkspace | null,
    recent: [],
    onDidChangeWorkspace: new Emitter<IWorkspace | null>().event,
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
  return render(
    <ServicesContext.Provider value={inst}>
      <SearchViewToolbar />
      <SearchView />
    </ServicesContext.Provider>,
  )
}

function makeFileMatch(path: string): IFileMatch {
  return {
    resource: URI.file(path),
    matches: [{ lineNumber: 1, preview: 'foo', ranges: [{ startColumn: 1, endColumn: 4 }] }],
  }
}

async function typeQuery(value: string) {
  const input = screen.getByLabelText('Search') as HTMLInputElement
  act(() => {
    fireEvent.change(input, { target: { value } })
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(400)
  })
}

function toolbarState() {
  return {
    refresh: screen.getByRole<HTMLButtonElement>('button', { name: 'Refresh' }).disabled,
    clear: screen.getByRole<HTMLButtonElement>('button', { name: 'Clear Search Results' }).disabled,
    collapse: screen.getByRole<HTMLButtonElement>('button', { name: 'Collapse All' }).disabled,
  }
}

describe('SearchViewToolbar enablement', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetSearchSession()
    searchViewState.setHasResults(false)
    searchViewState.setHasQuery(false)
    searchViewState.setViewMode('list')
  })

  afterEach(() => {
    vi.useRealTimers()
    cleanup()
  })

  it('disables every action without a query', () => {
    renderViewWithToolbar(new FakeTextSearch())
    expect(toolbarState()).toEqual({ refresh: true, clear: true, collapse: true })
  })

  it('enables refresh and clear with a query but no results', async () => {
    renderViewWithToolbar(new FakeTextSearch())
    await typeQuery('foo')
    expect(toolbarState()).toEqual({ refresh: false, clear: false, collapse: true })
  })

  it('enables every action with a query and results', async () => {
    const search = new FakeTextSearch()
    search.results = [makeFileMatch('/ws/a.ts')]
    renderViewWithToolbar(search)
    await typeQuery('foo')
    expect(toolbarState()).toEqual({ refresh: false, clear: false, collapse: false })
  })
})
