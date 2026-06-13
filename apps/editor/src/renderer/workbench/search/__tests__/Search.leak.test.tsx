/*---------------------------------------------------------------------------------------------
 *  Regression: the Search view's useEffect-owned event subscriptions must not
 *  surface as leaks while still mounted. The Restart Editor command snapshots
 *  the leak tracker after reactRoot.unmount() but before React 19 flushes
 *  passive cleanup, so live subscriptions created in useEffect appeared as
 *  leaks. They are wrapped in markAsSingleton (the established pattern, see
 *  TitleBar / Tree / ExplorerView / TerminalInstance): the tracker ignores
 *  them, a real unmount still disposes them.
 *
 *  - SearchResultsTree: model.onDidChangeStructure (persists collapsed state)
 *  - useSearchEngine:    workspaceService.onDidChangeWorkspace + fileWatcherService.onDidChangeFiles
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import {
  DisposableTracker,
  IFileWatcherService,
  IStatusBarService,
  ITextSearchService,
  IWorkspaceService,
  URI,
  setDisposableTracker,
  toDisposable,
  type IFileMatch,
} from '@universe-editor/platform'
import { SearchResultsTree } from '../SearchResultsTree.js'
import { useSearchEngine, type ISearchQuery } from '../useSearchEngine.js'
import { ServicesContext } from '../../useService.js'
import { searchViewState } from '../searchViewState.js'
import { searchSession } from '../searchSession.js'

afterEach(() => {
  cleanup()
  setDisposableTracker(null)
  searchViewState.setViewMode('list')
  searchSession.treeCollapsedIds = new Set()
})

function makeMatch(path: string): IFileMatch {
  return {
    resource: URI.file(path).toJSON(),
    matches: [{ lineNumber: 1, preview: 'foo bar', ranges: [{ startColumn: 1, endColumn: 4 }] }],
  }
}

describe('SearchResultsTree disposable hygiene', () => {
  it('does not report its onDidChangeStructure subscription as a leak while mounted', () => {
    const tracker = new DisposableTracker()
    setDisposableTracker(tracker)

    render(<SearchResultsTree results={[makeMatch('/ws/a.ts')]} onActivateMatch={() => {}} />)

    // Restart Editor snapshots leaks with React still mounted.
    const report = tracker.computeLeakingDisposables()
    expect(report?.details ?? '').not.toContain('SearchResultsTree')
  })
})

interface Tracked {
  workspaceDisposed: boolean
  filesDisposed: boolean
}

function makeContainer(tracked: Tracked) {
  const searchService = {
    _serviceBrand: undefined,
    search: () => Promise.resolve([]),
  }
  const statusBarService = {
    _serviceBrand: undefined,
    addEntry: () => ({ update: () => {}, dispose: () => {} }),
  }
  const fileWatcherService = {
    _serviceBrand: undefined,
    onDidChangeFiles: () =>
      toDisposable(() => {
        tracked.filesDisposed = true
      }),
  }
  const workspaceService = {
    _serviceBrand: undefined,
    onDidChangeWorkspace: () =>
      toDisposable(() => {
        tracked.workspaceDisposed = true
      }),
  }

  const map = new Map<unknown, unknown>([
    [ITextSearchService, searchService],
    [IStatusBarService, statusBarService],
    [IFileWatcherService, fileWatcherService],
    [IWorkspaceService, workspaceService],
  ])
  return {
    invokeFunction: (fn: (accessor: { get: (id: unknown) => unknown }) => unknown) =>
      fn({ get: (id: unknown) => map.get(id) }),
  }
}

// Non-empty initial results + non-empty pattern so the first debounced search is
// skipped (no searchService.search call) yet results stay non-empty — exercising
// both the unconditional onDidChangeWorkspace and the results-gated onDidChangeFiles.
const QUERY: ISearchQuery = {
  pattern: 'foo',
  isRegex: false,
  matchCase: false,
  matchWholeWord: false,
  includes: [],
  excludes: [],
  useExcludeSettings: true,
}

function Host() {
  useSearchEngine(QUERY, [makeMatch('/ws/a.ts')])
  return null
}

async function renderHost(tracked: Tracked) {
  const container = makeContainer(tracked)
  let unmount!: () => void
  await act(async () => {
    ;({ unmount } = render(
      <ServicesContext.Provider value={container as never}>
        <Host />
      </ServicesContext.Provider>,
    ))
  })
  return { unmount }
}

describe('useSearchEngine disposable hygiene', () => {
  it('does not report its useEffect subscriptions as leaks while mounted', async () => {
    const tracker = new DisposableTracker()
    setDisposableTracker(tracker)

    await renderHost({ workspaceDisposed: false, filesDisposed: false })

    const report = tracker.computeLeakingDisposables()
    expect(report?.details ?? '').not.toContain('useSearchEngine')
  })

  it('still disposes those subscriptions on unmount', async () => {
    const tracked: Tracked = { workspaceDisposed: false, filesDisposed: false }
    const { unmount } = await renderHost(tracked)

    await act(async () => {
      unmount()
    })

    expect(tracked.workspaceDisposed).toBe(true)
    expect(tracked.filesDisposed).toBe(true)
  })
})
