/*---------------------------------------------------------------------------------------------
 *  Tests for WorkspaceFileListingContribution: file-change / watcher-restart
 *  events invalidate the shared workspace file listing cache, and a delayed
 *  pre-warm walks the listing once so the first quick open is warm.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import {
  Emitter,
  URI,
  type CancellationToken,
  type IFileChangeEvent,
  type IFileSearchService as IFileSearchServiceType,
  type IFileWatcherService as IFileWatcherServiceType,
  type IWorkspace,
  type IWorkspaceService as IWorkspaceServiceType,
} from '@universe-editor/platform'
import {
  PREWARM_BUDGET_MS,
  WorkspaceFileListingContribution,
} from '../WorkspaceFileListingContribution.js'
import { FakeExcludeService } from '../../services/exclude/testing/fakeExcludeService.js'
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

function makeFileSearch(): IFileSearchServiceType & {
  calls: number
  queries: Array<{ timeoutMs: number | undefined }>
} {
  const svc = {
    _serviceBrand: undefined,
    calls: 0,
    queries: [] as Array<{ timeoutMs: number | undefined }>,
    // matchAll 清单的真实线形是 relPaths（不是 results）——预热走的就是这条路，
    // fake 必须如实模拟，否则 loadWorkspaceFiles 拿到的 entries 永远是空而测试照样绿。
    async search(query: { timeoutMs?: number }) {
      svc.calls++
      svc.queries.push({ timeoutMs: query.timeoutMs })
      return {
        relPaths: ['a.ts'],
        limitHit: false,
        filesWalked: 1,
        directoriesWalked: 1,
        durationMs: 0,
      }
    },
  } satisfies IFileSearchServiceType & {
    calls: number
    queries: Array<{ timeoutMs: number | undefined }>
  }
  return svc
}

function setup(fileSearch: ReturnType<typeof makeFileSearch> = makeFileSearch()) {
  const watcher = new FakeFileWatcherService()
  // Bypass DI for the trailing optional delay param — createInstance does not
  // forward extra args to optional constructor params.
  const contribution = new WorkspaceFileListingContribution(
    new FakeWorkspaceService(),
    watcher,
    fileSearch,
    new FakeExcludeService(),
    new FakeFocusScopeService(),
    0,
  )
  return { contribution, fileSearch, watcher }
}

function flush(ticks = 20): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ticks))
}

afterEach(() => invalidateMentionFileCache())

describe('WorkspaceFileListingContribution', () => {
  // 注：同包其他 contribution 常见的 createInstance(XxxContribution) DI 冒烟用例在这里
  // 不适用——本类带一个尾随的普通 number 参数，GetLeadingNonServiceArgs 推不出它
  // 「非服务」，createInstance 的重载在类型层匹配不上（运行时 ContributionService
  // 拿到的 ctor 类型是 new (...args: any[])，不报类型错；运行靠参数错位 + 默认
  // 值兜底）。DI 接线正确性由下面逐条行为测试覆盖。

  it('pre-warm walks the listing once', async () => {
    const { contribution, fileSearch } = setup()
    await flush()
    expect(fileSearch.calls).toBe(1)
    contribution.dispose()
  })

  it('pre-warm passes the walk budget down as the search timeout', async () => {
    const { contribution, fileSearch } = setup()
    await flush()
    expect(fileSearch.queries[0]?.timeoutMs).toBe(PREWARM_BUDGET_MS)
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

  it('disposing before the prewarm delay elapses never walks the listing', async () => {
    const watcher = new FakeFileWatcherService()
    const fileSearch = makeFileSearch()
    const contribution = new WorkspaceFileListingContribution(
      new FakeWorkspaceService(),
      watcher,
      fileSearch,
      new FakeExcludeService(),
      new FakeFocusScopeService(),
      // Long enough that the flush below never reaches the timer.
      60_000,
    )
    contribution.dispose()
    await flush()
    expect(fileSearch.calls).toBe(0)
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
    const { contribution } = setup(neverSettling as unknown as ReturnType<typeof makeFileSearch>)
    await flush()
    expect(neverSettling.calls).toBe(1)
    expect(seenToken?.isCancellationRequested).toBe(false)

    contribution.dispose()
    expect(seenToken?.isCancellationRequested).toBe(true)
  })
})
