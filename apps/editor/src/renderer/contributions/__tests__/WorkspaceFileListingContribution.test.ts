/*---------------------------------------------------------------------------------------------
 *  Tests for WorkspaceFileListingContribution: file-change / watcher-restart
 *  events invalidate the shared workspace file listing cache, and an idle
 *  pre-warm walks the listing once so the first quick open is warm.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import {
  Emitter,
  IFileSearchService,
  IFileWatcherService,
  InstantiationService,
  IWorkspaceService,
  ServiceCollection,
  URI,
  type CancellationToken,
  type IFileChangeEvent,
  type IFileSearchService as IFileSearchServiceType,
  type IFileWatcherService as IFileWatcherServiceType,
  type IWorkspace,
  type IWorkspaceService as IWorkspaceServiceType,
} from '@universe-editor/platform'
import { WorkspaceFileListingContribution } from '../WorkspaceFileListingContribution.js'
import { IExcludeService } from '../../services/exclude/ExcludeService.js'
import { FakeExcludeService } from '../../services/exclude/testing/fakeExcludeService.js'
import { IFocusScopeService } from '../../services/focus/FocusScopeService.js'
import { FakeFocusScopeService } from '../../services/focus/testing/fakeFocusScopeService.js'
import {
  invalidateMentionFileCache,
  loadWorkspaceFiles,
} from '../../services/acp/mentionFileSearch.js'

class FakeWorkspaceService implements IWorkspaceServiceType {
  declare readonly _serviceBrand: undefined
  readonly onDidChangeWorkspace = new Emitter<IWorkspace | null>().event
  readonly onDidChangeRecent = new Emitter<readonly never[]>().event
  readonly current: IWorkspace | null = { folder: URI.file('/ws'), name: 'ws' }
  readonly recent = [] as never[]
  readonly whenReady: Promise<void> = Promise.resolve()
  async openFolder() {}
  async closeFolder() {}
  async clearRecent() {}
  async removeRecent() {}
}

class FakeFileWatcherService implements IFileWatcherServiceType {
  declare readonly _serviceBrand: undefined
  readonly changes = new Emitter<readonly IFileChangeEvent[]>()
  readonly restarts = new Emitter<void>()
  readonly onDidChangeFiles = this.changes.event
  readonly onDidRestart = this.restarts.event
  async watch() {}
  async setExcludes() {}
  async unwatch() {}
  async watchOutOfWorkspace() {}
  async addOutOfWorkspaceFolder(): Promise<void> {}
  async removeOutOfWorkspaceFolder(): Promise<void> {}
  async clearOutOfWorkspaceFolders(): Promise<void> {}
}

function makeFileSearch(): IFileSearchServiceType & { calls: number } {
  const svc = {
    _serviceBrand: undefined,
    calls: 0,
    async search() {
      svc.calls++
      return {
        results: [
          {
            resource: URI.file('/ws/a.ts'),
            fsPath: '/ws/a.ts',
            relativePath: 'a.ts',
            basename: 'a.ts',
            score: 0,
          },
        ],
        limitHit: false,
        filesWalked: 1,
        directoriesWalked: 1,
        durationMs: 0,
      }
    },
  } satisfies IFileSearchServiceType & { calls: number }
  return svc
}

function setup(fileSearch: ReturnType<typeof makeFileSearch> = makeFileSearch()) {
  const watcher = new FakeFileWatcherService()
  const services = new ServiceCollection()
  services.set(IWorkspaceService, new FakeWorkspaceService())
  services.set(IFileWatcherService, watcher)
  services.set(IFileSearchService, fileSearch)
  services.set(IExcludeService, new FakeExcludeService())
  services.set(IFocusScopeService, new FakeFocusScopeService())
  const inst = new InstantiationService(services)
  const contribution = inst.createInstance(WorkspaceFileListingContribution)
  return { contribution, fileSearch, watcher }
}

function flush(ticks = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ticks))
}

afterEach(() => invalidateMentionFileCache())

describe('WorkspaceFileListingContribution', () => {
  it('idle pre-warm walks the listing once', async () => {
    const { contribution, fileSearch } = setup()
    await flush()
    expect(fileSearch.calls).toBe(1)
    contribution.dispose()
  })

  it('a file change invalidates the cached listing', async () => {
    const { contribution, fileSearch, watcher } = setup()
    await loadWorkspaceFiles(URI.file('/ws'), fileSearch, { dirNames: [] })
    expect(fileSearch.calls).toBe(1)

    watcher.changes.fire([{ type: 'added', resource: URI.file('/ws/b.ts') }])

    await loadWorkspaceFiles(URI.file('/ws'), fileSearch, { dirNames: [] })
    expect(fileSearch.calls).toBe(2)
    contribution.dispose()
  })

  it('a watcher restart invalidates the cached listing (events lost in the gap)', async () => {
    const { contribution, fileSearch, watcher } = setup()
    await loadWorkspaceFiles(URI.file('/ws'), fileSearch, { dirNames: [] })
    expect(fileSearch.calls).toBe(1)

    watcher.restarts.fire()

    await loadWorkspaceFiles(URI.file('/ws'), fileSearch, { dirNames: [] })
    expect(fileSearch.calls).toBe(2)
    contribution.dispose()
  })

  it('disposing the contribution cancels an in-flight pre-warm walk', async () => {
    let seenToken: CancellationToken | undefined
    const neverSettling = {
      _serviceBrand: undefined,
      calls: 0,
      search(_query: unknown, token?: CancellationToken) {
        neverSettling.calls++
        seenToken = token
        return new Promise<never>(() => {})
      },
    }
    const { contribution } = setup(neverSettling as ReturnType<typeof makeFileSearch>)
    await flush()
    expect(neverSettling.calls).toBe(1)
    expect(seenToken?.isCancellationRequested).toBe(false)

    contribution.dispose()
    expect(seenToken?.isCancellationRequested).toBe(true)
  })
})
