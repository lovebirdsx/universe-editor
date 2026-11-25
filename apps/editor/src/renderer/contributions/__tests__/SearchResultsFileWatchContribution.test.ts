/*---------------------------------------------------------------------------------------------
 *  Tests for SearchResultsFileWatchContribution — the session-cache side of the
 *  deletion follow-up: while the Search view is unmounted, deleting a file (or a
 *  directory) must drop its cached matches so reopening Search doesn't restore
 *  results for files that no longer exist.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it } from 'vitest'
import {
  Emitter,
  URI,
  UriIdentityService,
  type IFileChangeEvent,
  type IFileMatch,
  type IFileWatcherService,
  type ITextSearchMatch,
} from '@universe-editor/platform'
import { SearchResultsFileWatchContribution } from '../SearchResultsFileWatchContribution.js'
import { resetSearchSession, searchSession } from '../../workbench/search/searchSession.js'

class FakeWatcher implements IFileWatcherService {
  declare readonly _serviceBrand: undefined
  private readonly _emitter = new Emitter<readonly IFileChangeEvent[]>()
  readonly onDidChangeFiles = this._emitter.event
  readonly onDidRestart = new Emitter<void>().event
  async watch(): Promise<void> {}
  async setExcludes(): Promise<void> {}
  async unwatch(): Promise<void> {}
  async watchOutOfWorkspace(): Promise<void> {}
  async addOutOfWorkspaceFolder(): Promise<void> {}
  async removeOutOfWorkspaceFolder(): Promise<void> {}
  async clearOutOfWorkspaceFolders(): Promise<void> {}
  fire(events: readonly IFileChangeEvent[]): void {
    this._emitter.fire(events)
  }
}

const match: ITextSearchMatch = {
  lineNumber: 1,
  preview: 'foo',
  ranges: [{ startColumn: 1, endColumn: 4 }],
}

function makeFileMatch(path: string): IFileMatch {
  return { resource: URI.file(path), matches: [match] }
}

function resultPaths(): string[] {
  return searchSession.results.map((fm) => fm.resource.toString())
}

function setup(): { watcher: FakeWatcher } {
  const watcher = new FakeWatcher()
  new SearchResultsFileWatchContribution(watcher, new UriIdentityService('linux'))
  return { watcher }
}

describe('SearchResultsFileWatchContribution', () => {
  beforeEach(() => {
    resetSearchSession()
  })

  it('drops cached matches when a result file is deleted', () => {
    const { watcher } = setup()
    searchSession.results = [makeFileMatch('/ws/a.ts'), makeFileMatch('/ws/b.ts')]
    watcher.fire([{ type: 'deleted', resource: URI.file('/ws/a.ts') }])
    expect(resultPaths()).toEqual([URI.file('/ws/b.ts').toString()])
  })

  it('drops cached matches nested under a deleted directory', () => {
    const { watcher } = setup()
    searchSession.results = [makeFileMatch('/ws/dir/a.ts'), makeFileMatch('/ws/other.ts')]
    watcher.fire([{ type: 'deleted', resource: URI.file('/ws/dir') }])
    expect(resultPaths()).toEqual([URI.file('/ws/other.ts').toString()])
  })

  it('keeps cached matches for content changes and unrelated deletions', () => {
    const { watcher } = setup()
    searchSession.results = [makeFileMatch('/ws/a.ts')]
    watcher.fire([
      { type: 'modified', resource: URI.file('/ws/a.ts') },
      { type: 'deleted', resource: URI.file('/ws/other.ts') },
    ])
    expect(resultPaths()).toEqual([URI.file('/ws/a.ts').toString()])
  })

  it('leaves an empty cache alone', () => {
    const { watcher } = setup()
    watcher.fire([{ type: 'deleted', resource: URI.file('/ws/a.ts') }])
    expect(searchSession.results).toEqual([])
  })

  it('stops following deletions once disposed', () => {
    const watcher = new FakeWatcher()
    const contribution = new SearchResultsFileWatchContribution(
      watcher,
      new UriIdentityService('linux'),
    )
    searchSession.results = [makeFileMatch('/ws/a.ts')]
    contribution.dispose()
    watcher.fire([{ type: 'deleted', resource: URI.file('/ws/a.ts') }])
    expect(resultPaths()).toEqual([URI.file('/ws/a.ts').toString()])
  })
})
