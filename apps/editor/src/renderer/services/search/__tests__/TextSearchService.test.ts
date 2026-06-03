/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/search/TextSearchService.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import {
  Emitter,
  Event,
  LogLevel,
  URI,
  type IFileMatch,
  type ILoggerService,
  type ITextSearchProgress,
  type IWorkspace,
  type IWorkspaceService,
} from '@universe-editor/platform'
import { TextSearchService } from '../TextSearchService.js'
import { FakeExcludeService } from '../../exclude/testing/fakeExcludeService.js'
import type {
  ITextSearchMainComplete,
  ITextSearchMainProgressEvent,
  ITextSearchMainQuery,
  ITextSearchMainService,
} from '../../../../shared/ipc/textSearchService.js'

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
    resource: URI.file(path).toJSON(),
    matches: [{ lineNumber: 1, preview: 'foo', ranges: [{ startColumn: 1, endColumn: 4 }] }],
  }
}

function makeService(
  root: URI | null,
  main = new FakeMainSearch(),
): {
  readonly main: FakeMainSearch
  readonly service: TextSearchService
} {
  const exclude = new FakeSearchExcludeService()
  return {
    main,
    service: new TextSearchService(new FakeWorkspace(root), main, exclude, makeLoggerService()),
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
})
