/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/search/TextSearchService.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import {
  DisposableTracker,
  Emitter,
  Event,
  LogLevel,
  setDisposableTracker,
  URI,
  UriIdentityService,
  type IEditorGroupsService,
  type IConfigurationService,
  type IFileMatch,
  type ILoggerService,
  type ITextSearchProgress,
  type IWorkspace,
  type IWorkspaceService,
} from '@universe-editor/platform'
import { TextSearchService } from '../TextSearchService.js'
import { FakeExcludeService } from '../../exclude/testing/fakeExcludeService.js'
import { FakeFocusScopeService } from '../../focus/testing/fakeFocusScopeService.js'
import type {
  ITextSearchMainComplete,
  ITextSearchMainProgressEvent,
  ITextSearchMainQuery,
  ITextSearchMainResultsEvent,
  ITextSearchMainService,
} from '@universe-editor/platform'

class FakeWorkspace implements IWorkspaceService {
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

class FakeMainSearch implements ITextSearchMainService {
  declare readonly _serviceBrand: undefined
  private readonly _onDidSearchProgress = new Emitter<ITextSearchMainProgressEvent>()
  readonly onDidSearchProgress = this._onDidSearchProgress.event
  private readonly _onDidSearchResults = new Emitter<ITextSearchMainResultsEvent>()
  readonly onDidSearchResults = this._onDidSearchResults.event
  readonly queries: ITextSearchMainQuery[] = []
  readonly cancelCalls: string[] = []
  results: readonly IFileMatch[] = []
  waitForCancel = false
  private _resolveCancel: (() => void) | null = null

  async search(query: ITextSearchMainQuery): Promise<ITextSearchMainComplete> {
    this.queries.push(query)
    const progress: ITextSearchProgress = {
      filesScanned: 10,
      filesMatched: this.results.length,
      totalMatches: 1,
    }
    this._onDidSearchProgress.fire({ sessionId: query.sessionId, progress })
    if (this.results.length > 0) {
      this._onDidSearchResults.fire({ sessionId: query.sessionId, results: this.results })
    }
    if (this.waitForCancel) {
      await new Promise<void>((resolve) => {
        this._resolveCancel = resolve
      })
    }
    return { results: this.results, progress, durationMs: 1 }
  }

  async cancel(sessionId: string): Promise<void> {
    this.cancelCalls.push(sessionId)
    this._resolveCancel?.()
  }
}

class FakeSearchExcludeService extends FakeExcludeService {
  override getSearchExcludeGlobs(): string[] {
    return ['node_modules']
  }
}

function makeLoggerService(): ILoggerService {
  return {
    _serviceBrand: undefined,
    createLogger: () => ({
      level: LogLevel.Info,
      onDidChangeLogLevel: Event.None,
      setLevel: vi.fn(),
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      flush: vi.fn(),
      dispose: vi.fn(),
    }),
    setLevel: () => {},
    getLevel: () => LogLevel.Info,
  }
}

function makeMatch(path: string): IFileMatch {
  return {
    resource: URI.file(path),
    matches: [{ lineNumber: 1, preview: 'foo', ranges: [{ startColumn: 1, endColumn: 4 }] }],
  }
}

function makeService(
  root: URI | null,
  main = new FakeMainSearch(),
  threads = 0,
  focus = new FakeFocusScopeService(),
): {
  readonly main: FakeMainSearch
  readonly service: TextSearchService
} {
  const exclude = new FakeSearchExcludeService()
  const editorGroups = { _serviceBrand: undefined, groups: [] } as unknown as IEditorGroupsService
  const config = {
    _serviceBrand: undefined,
    get: <T>(key: string, defaultValue?: T) => (key === 'search.threads' ? threads : defaultValue),
  } as unknown as IConfigurationService
  return {
    main,
    service: new TextSearchService(
      new FakeWorkspace(root),
      main,
      exclude,
      editorGroups,
      new UriIdentityService('linux'),
      config,
      makeLoggerService(),
      focus,
    ),
  }
}

describe('TextSearchService renderer adapter', () => {
  it('sends workspace root, query options and configured excludes to main search', async () => {
    const root = URI.file('/ws')
    const { main, service } = makeService(root)
    main.results = [makeMatch('/ws/a.ts')]

    const results = await service.search({
      pattern: 'foo',
      isRegex: false,
      matchCase: true,
      matchWholeWord: false,
      includes: ['**/*.ts'],
      excludes: ['**/*.test.ts'],
    })

    expect(results).toHaveLength(1)
    expect(main.queries).toHaveLength(1)
    expect(URI.revive(main.queries[0]!.root)!.toString()).toBe(root.toString())
    expect(main.queries[0]!.includes).toEqual(['**/*.ts'])
    expect(main.queries[0]!.excludes).toEqual(['**/*.test.ts'])
    expect(main.queries[0]!.configurationExcludes).toEqual(['node_modules'])
  })

  it('forwards the configured search.threads to the main query', async () => {
    const root = URI.file('/ws')

    const explicit = makeService(root, undefined, 8)
    await explicit.service.search({
      pattern: 'foo',
      isRegex: false,
      matchCase: true,
      matchWholeWord: false,
      includes: [],
      excludes: [],
    })
    expect(explicit.main.queries[0]!.threads).toBe(8)

    const automatic = makeService(root)
    await automatic.service.search({
      pattern: 'foo',
      isRegex: false,
      matchCase: true,
      matchWholeWord: false,
      includes: [],
      excludes: [],
    })
    expect(automatic.main.queries[0]!.threads).toBe(0)
  })

  it('routes progress events for the current search session', async () => {
    const { service } = makeService(URI.file('/ws'))
    const onProgress = vi.fn()

    await service.search(
      {
        pattern: 'foo',
        isRegex: false,
        matchCase: false,
        matchWholeWord: false,
        includes: [],
        excludes: [],
      },
      { onProgress },
    )

    expect(onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ filesScanned: 10, totalMatches: 1 }),
    )
  })

  it('cancels the main-process session when AbortSignal fires', async () => {
    const main = new FakeMainSearch()
    main.waitForCancel = true
    const { service } = makeService(URI.file('/ws'), main)
    const ac = new AbortController()

    const promise = service.search(
      {
        pattern: 'foo',
        isRegex: false,
        matchCase: false,
        matchWholeWord: false,
        includes: [],
        excludes: [],
      },
      { signal: ac.signal },
    )
    await Promise.resolve()
    ac.abort()
    await promise

    expect(main.cancelCalls).toEqual([main.queries[0]!.sessionId])
  })

  it('keeps in-flight search listeners rooted so teardown snapshots stay clean', async () => {
    const tracker = new DisposableTracker()
    setDisposableTracker(tracker)
    try {
      const main = new FakeMainSearch()
      main.waitForCancel = true
      const { service } = makeService(URI.file('/ws'), main)

      const promise = service.search({
        pattern: 'foo',
        isRegex: false,
        matchCase: false,
        matchWholeWord: false,
        includes: [],
        excludes: [],
      })
      await Promise.resolve()

      // The search promise has not settled (e2e teardown can snapshot here);
      // the listeners are still legitimately alive and must not count as leaks.
      expect(tracker.computeLeakingDisposables()).toBeUndefined()

      await main.cancel(main.queries[0]!.sessionId)
      await promise
      expect(tracker.computeLeakingDisposables()).toBeUndefined()
    } finally {
      setDisposableTracker(null)
    }
  })

  it('returns an empty result without calling main search when no workspace is open', async () => {
    const { main, service } = makeService(null)

    const results = await service.search({
      pattern: 'foo',
      isRegex: false,
      matchCase: false,
      matchWholeWord: false,
      includes: [],
      excludes: [],
    })

    expect(results).toEqual([])
    expect(main.queries).toHaveLength(0)
  })

  it('returns an empty result without calling main search for invalid regex', async () => {
    const { main, service } = makeService(URI.file('/ws'))

    const results = await service.search({
      pattern: '(',
      isRegex: true,
      matchCase: false,
      matchWholeWord: false,
      includes: [],
      excludes: [],
    })

    expect(results).toEqual([])
    expect(main.queries).toHaveLength(0)
  })

  it('narrows the main query to the focus folders when focus is active', async () => {
    const focus = new FakeFocusScopeService(['Client', 'Tools/Editor'], URI.file('/ws'))
    const { main, service } = makeService(URI.file('/ws'), undefined, 0, focus)

    await service.search({
      pattern: 'foo',
      isRegex: false,
      matchCase: true,
      matchWholeWord: false,
      includes: [],
      excludes: [],
    })

    expect(main.queries).toHaveLength(1)
    expect(main.queries[0]!.scanPaths).toEqual(['Client', 'Tools/Editor'])
    expect(main.queries[0]!.rootFilesInScope).toBe(true)
  })

  it('leaves the main query whole-root when focus is inactive', async () => {
    const { main, service } = makeService(URI.file('/ws'))

    await service.search({
      pattern: 'foo',
      isRegex: false,
      matchCase: true,
      matchWholeWord: false,
      includes: [],
      excludes: [],
    })

    expect(main.queries).toHaveLength(1)
    expect(main.queries[0]!.scanPaths).toBeUndefined()
    expect(main.queries[0]!.rootFilesInScope).toBe(false)
  })
})
