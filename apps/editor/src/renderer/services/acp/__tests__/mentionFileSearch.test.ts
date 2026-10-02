/*---------------------------------------------------------------------------------------------
 *  Tests for the @-mention file search:
 *    - loadWorkspaceFiles caches per-URI and returns relative paths
 *    - filterMentionFiles ranks basename matches above path matches
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CancellationError,
  CancellationTokenSource,
  URI,
  type CancellationToken,
  type IFileSearchComplete,
  type IFileSearchService,
} from '@universe-editor/platform'
import { _resetPerfPhasesForTests, getRecordedPhases } from '../../performance/perfPhases.js'
import {
  buildMentionEntries,
  buildMentionEntrySlice,
  filterMentionFiles,
  invalidateMentionFileCache,
  loadWorkspaceFiles,
  peekWorkspaceFiles,
  releaseMentionFileCache,
  type MentionFileEntry,
} from '../mentionFileSearch.js'

afterEach(() => invalidateMentionFileCache())

function relativePath(root: URI, abs: string): string {
  const rootPath = root.fsPath.replace(/\\/g, '/').replace(/\/$/, '')
  const norm = abs.replace(/\\/g, '/')
  return norm.startsWith(rootPath + '/')
    ? norm.slice(rootPath.length + 1)
    : norm.startsWith(rootPath)
      ? norm.slice(rootPath.length)
      : norm
}

/** 模拟主进程：`relPaths` 一律 `/` 分隔，截断且调用方要求丢弃时整份为空。 */
function fakeFileSearch(paths: readonly string[], limitHit = false): IFileSearchService {
  return {
    _serviceBrand: undefined,
    async search(query) {
      const relPaths =
        limitHit && query.omitTruncatedListing === true
          ? []
          : paths.map((abs) => relativePath(query.root, abs))
      return {
        relPaths,
        limitHit,
        filesWalked: paths.length,
        directoriesWalked: 1,
        durationMs: 0,
        ...(limitHit ? { stopReason: 'maxResults' as const } : {}),
      }
    },
  }
}

/** `fakeFileSearch` plus a walk counter, for the cache-behaviour cases. */
function countingFake(
  paths: readonly string[],
  limitHit = false,
): { readonly fs: IFileSearchService; readonly calls: () => number } {
  let calls = 0
  const base = fakeFileSearch(paths, limitHit)
  return {
    fs: {
      _serviceBrand: undefined,
      async search(query, token) {
        calls++
        return base.search(query, token)
      },
    },
    calls: () => calls,
  }
}

describe('loadWorkspaceFiles', () => {
  it('returns entries with workspace-relative paths and marks the listing complete', async () => {
    const root = URI.file('/repo')
    const fs = fakeFileSearch(['/repo/src/main.ts', '/repo/README.md'])
    const { entries, complete } = await loadWorkspaceFiles(root, fs)
    expect(complete).toBe(true)
    expect(entries.map((e) => e.relPath).sort()).toEqual(['README.md', 'src/main.ts'])
    expect(entries.find((e) => e.relPath === 'src/main.ts')?.name).toBe('main.ts')
    expect(entries.find((e) => e.relPath === 'src/main.ts')?.uri).toBe(
      URI.file('/repo/src/main.ts').toString(),
    )
  })

  it('marks a limit-hit walk incomplete and caches that flag', async () => {
    const root = URI.file('/repo')
    const { fs } = countingFake(['/repo/a.ts'], true)
    const listing = await loadWorkspaceFiles(root, fs)
    expect(listing.complete).toBe(false)
    // 巨型工作区的截断清单被整份丢弃（renderer 不持有残缺子集），但"未走完"这个
    // 事实必须随缓存活下来，消费方才能改走击键兜底搜索。
    expect(peekWorkspaceFiles(root)?.complete).toBe(false)
    expect(peekWorkspaceFiles(root)?.entries).toHaveLength(0)
  })

  it('derives the display name and URI from the nested relative path', async () => {
    const root = URI.file('C:/repo')
    const { fs } = countingFake(['C:/repo/src/deep/main.ts'])
    const { entries } = await loadWorkspaceFiles(root, fs)
    expect(entries[0]?.relPath).toBe('src/deep/main.ts')
    expect(entries[0]?.name).toBe('main.ts')
    expect(entries[0]?.uri).toBe(URI.file('C:/repo/src/deep/main.ts').toString())
  })

  it('caches results within the TTL window', async () => {
    const root = URI.file('/repo')
    const { fs, calls } = countingFake(['/repo/a.ts'])
    await loadWorkspaceFiles(root, fs)
    await loadWorkspaceFiles(root, fs)
    expect(calls()).toBe(1)
  })

  it('invalidateMentionFileCache forces a re-walk', async () => {
    const root = URI.file('/repo')
    const { fs, calls } = countingFake(['/repo/a.ts'])
    await loadWorkspaceFiles(root, fs)
    invalidateMentionFileCache(root)
    await loadWorkspaceFiles(root, fs)
    expect(calls()).toBe(2)
  })

  it('invalidateMentionFileCache drops listings walked under a subdirectory', async () => {
    const root = URI.file('/repo')
    const sub = URI.joinPath(root, 'packages/app')
    const { fs } = countingFake(['/repo/a.ts'])
    await loadWorkspaceFiles(root, fs)
    await loadWorkspaceFiles(sub, fs)

    // File changes are reported against the workspace root, so a session rooted
    // at a subdirectory would otherwise never have its listing invalidated.
    invalidateMentionFileCache(root)
    expect(peekWorkspaceFiles(root)).toBeUndefined()
    expect(peekWorkspaceFiles(sub)).toBeUndefined()
  })

  it('invalidateMentionFileCache leaves roots outside the subtree alone', async () => {
    const root = URI.file('/repo')
    const sibling = URI.file('/repo/submarine')
    const { fs } = countingFake(['/repo/a.ts'])
    await loadWorkspaceFiles(root, fs)
    await loadWorkspaceFiles(sibling, fs)

    invalidateMentionFileCache(URI.file('/repo/sub'))
    expect(peekWorkspaceFiles(root)?.entries).toHaveLength(1)
    expect(peekWorkspaceFiles(sibling)?.entries).toHaveLength(1)
  })

  it('invalidateMentionFileCache folds case when matching descendants', async () => {
    const sub = URI.file('c:/repo/sub')
    const { fs } = countingFake(['c:/repo/sub/a.ts'])
    await loadWorkspaceFiles(sub, fs)

    invalidateMentionFileCache(URI.file('C:/repo'))
    expect(peekWorkspaceFiles(sub)).toBeUndefined()
  })

  it('invalidateMentionFileCache clears every root when called without one', async () => {
    const root = URI.file('/repo')
    const sub = URI.joinPath(root, 'packages/app')
    const { fs } = countingFake(['/repo/a.ts'])
    await loadWorkspaceFiles(root, fs)
    await loadWorkspaceFiles(sub, fs)

    invalidateMentionFileCache()
    expect(peekWorkspaceFiles(root)).toBeUndefined()
    expect(peekWorkspaceFiles(sub)).toBeUndefined()
  })

  it('peekWorkspaceFiles returns the stale listing past the TTL without re-walking', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const root = URI.file('/repo')
      const { fs, calls } = countingFake(['/repo/a.ts'])
      await loadWorkspaceFiles(root, fs)
      expect(calls()).toBe(1)

      // Past the TTL the listing is stale, but peeking still serves it
      // instantly (stale-while-revalidate) and triggers no walk.
      vi.setSystemTime(Date.now() + 60 * 60_000)
      expect(peekWorkspaceFiles(root)?.entries.map((e) => e.relPath)).toEqual(['a.ts'])
      expect(calls()).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('peekWorkspaceFiles returns undefined when nothing was ever cached', () => {
    expect(peekWorkspaceFiles(URI.file('/never-loaded'))).toBeUndefined()
  })

  it('passes the caller token through and does not cache a cancelled walk', async () => {
    const root = URI.file('/repo')
    let calls = 0
    let seenToken: CancellationToken | undefined
    const fs = {
      _serviceBrand: undefined,
      async search(_query, token) {
        calls++
        seenToken = token
        return {
          relPaths: [],
          limitHit: true,
          filesWalked: 0,
          directoriesWalked: 0,
          durationMs: 0,
          stopReason: 'canceled' as const,
        }
      },
    } satisfies IFileSearchService
    const cts = new CancellationTokenSource()

    await loadWorkspaceFiles(root, fs, undefined, cts.token)
    expect(seenToken).toBe(cts.token)

    // A cancelled walk yields a partial listing — caching it would serve a
    // truncated workspace for the whole TTL, so the next call must re-walk.
    await loadWorkspaceFiles(root, fs, undefined, cts.token)
    expect(calls).toBe(2)
    expect(peekWorkspaceFiles(root)).toBeUndefined()
  })

  it('partitions the cache by focus fingerprint and forwards the scope to the walk', async () => {
    const root = URI.file('/repo')
    const seenQueries: { scanPaths?: readonly string[]; rootFilesInScope: boolean | undefined }[] =
      []
    let calls = 0
    const fs = {
      _serviceBrand: undefined,
      async search(query) {
        calls++
        seenQueries.push({
          ...(query.scanPaths ? { scanPaths: query.scanPaths } : {}),
          rootFilesInScope: query.rootFilesInScope,
        })
        return {
          relPaths: [],
          limitHit: false,
          filesWalked: 0,
          directoriesWalked: 0,
          durationMs: 0,
        }
      },
    } satisfies IFileSearchService

    const focusA = { scanPaths: ['Client'] as const, rootFilesInScope: true, fingerprint: 'a' }
    const focusB = { scanPaths: ['Engine'] as const, rootFilesInScope: false, fingerprint: 'b' }

    await loadWorkspaceFiles(root, fs, undefined, undefined, focusA)
    await loadWorkspaceFiles(root, fs, undefined, undefined, focusA)
    expect(calls).toBe(1)

    // 同一 root、不同 fingerprint = 不同缓存键：必须重新 walk。
    await loadWorkspaceFiles(root, fs, undefined, undefined, focusB)
    expect(calls).toBe(2)

    expect(peekWorkspaceFiles(root, undefined, focusA)).toBeDefined()
    expect(peekWorkspaceFiles(root, undefined, focusB)).toBeDefined()

    expect(seenQueries[0]).toEqual({ scanPaths: ['Client'], rootFilesInScope: true })
    expect(seenQueries[1]).toEqual({ scanPaths: ['Engine'], rootFilesInScope: false })
  })

  it('partitions the cache by useIgnoreFiles and forwards it to the walk', async () => {
    const root = URI.file('/repo')
    const seen: (boolean | undefined)[] = []
    let calls = 0
    const fs = {
      _serviceBrand: undefined,
      async search(query) {
        calls++
        seen.push(query.useIgnoreFiles)
        return {
          relPaths: [],
          limitHit: false,
          filesWalked: 0,
          directoriesWalked: 0,
          durationMs: 0,
        }
      },
    } satisfies IFileSearchService

    const honouring = { dirNames: [], excludeGlobs: [], useIgnoreFiles: true }
    const ignoring = { dirNames: [], excludeGlobs: [], useIgnoreFiles: false }

    await loadWorkspaceFiles(root, fs, honouring)
    await loadWorkspaceFiles(root, fs, honouring)
    expect(calls).toBe(1)

    // Sharing one cache entry between the two settings would serve the other
    // setting's file set for the whole TTL.
    await loadWorkspaceFiles(root, fs, ignoring)
    expect(calls).toBe(2)
    expect(seen).toEqual([true, false])

    expect(peekWorkspaceFiles(root, honouring)).toBeDefined()
    expect(peekWorkspaceFiles(root, ignoring)).toBeDefined()
  })

  it('does not narrow the walk when no focus is given', async () => {
    const root = URI.file('/repo')
    let seenScanPaths: readonly string[] | undefined = ['sentinel']
    const fs = {
      _serviceBrand: undefined,
      async search(query) {
        seenScanPaths = query.scanPaths
        return {
          relPaths: [],
          limitHit: false,
          filesWalked: 0,
          directoriesWalked: 0,
          durationMs: 0,
        }
      },
    } satisfies IFileSearchService

    await loadWorkspaceFiles(root, fs)
    expect(seenScanPaths).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// 分片构造：大清单在分片边界让出事件循环，小清单保持同步快路径
// ---------------------------------------------------------------------------

const BUILD_LARGE = 3_000

function manyPaths(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `/repo/f${i}.ts`)
}

/** 每次 search 都挂起，由测试按调用序号决定何时、以哪些路径完成 —— 用来制造
 *  「旧请求晚于新请求完成」「walk 途中失效/释放」这类重叠时序。 */
function deferredFileSearch(): {
  readonly fs: IFileSearchService
  readonly calls: () => number
  readonly resolve: (index: number, relPaths: readonly string[]) => void
} {
  const pending: Array<(value: IFileSearchComplete) => void> = []
  let calls = 0
  const fs = {
    _serviceBrand: undefined,
    search(): Promise<IFileSearchComplete> {
      return new Promise((resolve) => {
        pending[calls++] = resolve
      })
    },
  } satisfies IFileSearchService
  return {
    fs,
    calls: () => calls,
    resolve(index, relPaths) {
      pending[index]!({
        relPaths: [...relPaths],
        limitHit: false,
        filesWalked: relPaths.length,
        directoriesWalked: 1,
        durationMs: 0,
      })
    },
  }
}

function flushMacrotask(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('loadWorkspaceFiles — chunked entry construction', () => {
  it('yields the event loop between slices for a large listing, without loss or reorder', async () => {
    const root = URI.file('/repo')
    const events: string[] = []
    const pending = loadWorkspaceFiles(root, fakeFileSearch(manyPaths(BUILD_LARGE)))
    // 让出是宏任务级的：清单构造若真的分片让出，这个定时器会在 load 完成前触发。
    setTimeout(() => events.push('timer'), 0)
    const listing = await pending
    events.push('done')

    expect(events).toEqual(['timer', 'done'])
    expect(listing.entries).toHaveLength(BUILD_LARGE)
    expect(listing.entries[0]?.uri).toBe(URI.file('/repo/f0.ts').toString())
    expect(listing.entries[BUILD_LARGE - 1]?.relPath).toBe(`f${BUILD_LARGE - 1}.ts`)
    expect(new Set(listing.entries.map((e) => e.relPath)).size).toBe(BUILD_LARGE)
  })

  it('leaves a small listing that completes in its first slice without an extra yield', async () => {
    const root = URI.file('/repo')
    const events: string[] = []
    const pending = loadWorkspaceFiles(root, fakeFileSearch(['/repo/a.ts']))
    setTimeout(() => events.push('timer'), 0)
    await pending
    events.push('done')
    // 完成先于定时器：小清单在首片内建完，不再额外让出（预算检查仍在，只是没触发）。
    expect(events).toEqual(['done'])
  })

  it('rejects a small listing whose token was cancelled during the walk, caching nothing', async () => {
    const root = URI.file('/repo')
    const cts = new CancellationTokenSource()
    let calls = 0
    const fs = {
      _serviceBrand: undefined,
      async search() {
        calls++
        // 取消发生在 walk 途中：路径已到手，但调用方已经不要这份清单了。
        cts.cancel()
        return {
          relPaths: ['a.ts'],
          limitHit: false,
          filesWalked: 1,
          directoriesWalked: 1,
          durationMs: 0,
        }
      },
    } satisfies IFileSearchService

    await expect(loadWorkspaceFiles(root, fs, undefined, cts.token)).rejects.toBeInstanceOf(
      CancellationError,
    )
    expect(peekWorkspaceFiles(root)).toBeUndefined()

    // 未缓存 ⇒ 下一次调用必须重新 walk。
    await loadWorkspaceFiles(root, fs)
    expect(calls).toBe(2)
  })

  it('abandons a build cancelled mid-way: rejects, caches nothing, returns no half listing', async () => {
    const root = URI.file('/repo')
    const { fs, calls } = countingFake(manyPaths(BUILD_LARGE))
    const cts = new CancellationTokenSource()
    const pending = loadWorkspaceFiles(root, fs, undefined, cts.token)
    const assertion = expect(pending).rejects.toBeInstanceOf(CancellationError)
    // 先让清单落地、首片构造完（让出挂在分片边界），再取消：早停发生在分片边界，
    // 而不是"拒绝启动"。已构造的部分不得作为结果返回，也不得进缓存。
    await flushMacrotask()
    cts.cancel()
    await assertion
    expect(peekWorkspaceFiles(root)).toBeUndefined()

    // 不缓存 ⇒ 下一次调用必须重新 walk。
    await loadWorkspaceFiles(root, fs)
    expect(calls()).toBe(2)
  })

  it('never lets a walk that started before an invalidation refill the cache', async () => {
    const root = URI.file('/repo')
    const deferred = deferredFileSearch()
    const pending = loadWorkspaceFiles(root, deferred.fs)
    // watcher 事件在 walk 途中到达：这份"变更前"的数据可以回给发起方，但不得回灌缓存。
    invalidateMentionFileCache(root)
    deferred.resolve(0, ['a.ts'])
    const listing = await pending
    expect(listing.entries.map((e) => e.relPath)).toEqual(['a.ts'])
    expect(peekWorkspaceFiles(root)).toBeUndefined()
  })

  it('a superseded load must not clobber the newer listing when it finishes later', async () => {
    const root = URI.file('/repo')
    const deferred = deferredFileSearch()
    const older = loadWorkspaceFiles(root, deferred.fs)
    const newer = loadWorkspaceFiles(root, deferred.fs)
    expect(deferred.calls()).toBe(2)

    deferred.resolve(1, ['new.ts'])
    await newer
    expect(peekWorkspaceFiles(root)?.entries.map((e) => e.relPath)).toEqual(['new.ts'])

    // 旧请求后完成：结果仍返回给它的发起方，但不得覆盖较新的缓存。
    deferred.resolve(0, ['old.ts'])
    expect((await older).entries.map((e) => e.relPath)).toEqual(['old.ts'])
    expect(peekWorkspaceFiles(root)?.entries.map((e) => e.relPath)).toEqual(['new.ts'])
  })

  it('a per-root invalidation only blocks the in-flight loads it speaks for', async () => {
    const rootA = URI.file('/repo-a')
    const subA = URI.joinPath(rootA, 'packages/app')
    const rootB = URI.file('/repo-b')
    const deferredA = deferredFileSearch()
    const deferredSub = deferredFileSearch()
    const deferredB = deferredFileSearch()
    const pendingA = loadWorkspaceFiles(rootA, deferredA.fs)
    const pendingSub = loadWorkspaceFiles(subA, deferredSub.fs)
    const pendingB = loadWorkspaceFiles(rootB, deferredB.fs)

    // watcher 事件只针对 rootA：rootA 与它子树上的在途 walk 失去回灌资格（它们的
    // 数据早于这次变更），但无关的 rootB 仍必须能把清单写进缓存——它没有任何理由
    // 被别的 root 的失效牵连。
    invalidateMentionFileCache(rootA)
    deferredA.resolve(0, ['a.ts'])
    deferredSub.resolve(0, ['sub.ts'])
    deferredB.resolve(0, ['b.ts'])
    const [listingA, listingSub, listingB] = await Promise.all([pendingA, pendingSub, pendingB])

    // 结果仍回给各自的发起方（"变更前"的这份数据不是错误），落不落缓存才是差别。
    expect(listingA.entries.map((e) => e.relPath)).toEqual(['a.ts'])
    expect(listingSub.entries.map((e) => e.relPath)).toEqual(['sub.ts'])
    expect(listingB.entries.map((e) => e.relPath)).toEqual(['b.ts'])
    expect(peekWorkspaceFiles(rootA)).toBeUndefined()
    expect(peekWorkspaceFiles(subA)).toBeUndefined()
    expect(peekWorkspaceFiles(rootB)?.entries.map((e) => e.relPath)).toEqual(['b.ts'])
  })

  it('a global clear blocks in-flight walks of every root from refilling the cache', async () => {
    const rootA = URI.file('/repo-a')
    const rootB = URI.file('/repo-b')
    const deferredA = deferredFileSearch()
    const deferredB = deferredFileSearch()
    const pendingA = loadWorkspaceFiles(rootA, deferredA.fs)
    const pendingB = loadWorkspaceFiles(rootB, deferredB.fs)

    invalidateMentionFileCache()
    deferredA.resolve(0, ['a.ts'])
    deferredB.resolve(0, ['b.ts'])
    await Promise.all([pendingA, pendingB])

    expect(peekWorkspaceFiles(rootA)).toBeUndefined()
    expect(peekWorkspaceFiles(rootB)).toBeUndefined()
  })

  it('a memory release blocks an in-flight walk from refilling the cache', async () => {
    const root = URI.file('/repo')
    const deferred = deferredFileSearch()
    const pending = loadWorkspaceFiles(root, deferred.fs)
    releaseMentionFileCache(0)
    deferred.resolve(0, ['a.ts'])
    expect((await pending).entries).toHaveLength(1)
    expect(peekWorkspaceFiles(root)).toBeUndefined()
  })

  it('bounds one slice by entry count and by the time budget (deterministic clock)', () => {
    const root = URI.file('/repo')
    const relPaths = manyPaths(2_000).map((p) => p.slice('/repo/'.length))
    const entries: MentionFileEntry[] = new Array<MentionFileEntry>(relPaths.length)

    // 冻结时钟：分片在 1024 条上限处停下（预算检查永不触发）。
    expect(buildMentionEntrySlice(root, relPaths, 0, entries, () => 0)).toBe(1_024)
    expect(entries[1_023]?.uri).toBe(URI.joinPath(root, 'f1023.ts').toString())

    // 时钟在 256 条检查点已越过预算：分片提前结束（让出由异步包装做）。
    let t = 0
    expect(buildMentionEntrySlice(root, relPaths, 0, [], () => (t += 100))).toBe(256)
  })

  it('records each over-budget slice as its own real span, never a summed pseudo-span', async () => {
    _resetPerfPhasesForTests()
    const root = URI.file('/repo')
    const relPaths = manyPaths(BUILD_LARGE).map((p) => p.slice('/repo/'.length))
    const entries: MentionFileEntry[] = new Array<MentionFileEntry>(relPaths.length)
    // 冻结推进的时钟：每个分片在 256 条检查点越过预算而提前收兵，于是每一片都超预算，
    // 逐片落一条相位（真实起止由这只时钟直接读出）。
    let t = 0
    const now = (): number => (t += 100)
    await buildMentionEntries(root, relPaths, undefined, { now, budgetMs: 8, slowMs: 8 })
    expect(entries).toHaveLength(BUILD_LARGE)

    const slices = getRecordedPhases().filter((p) =>
      p.name.startsWith('mentionFileSearch.buildSlice'),
    )
    // 3000 条 / 每片 256 条 = 11 片整 + 184 条的收尾片。
    expect(slices.filter((s) => s.name.includes('256 entries'))).toHaveLength(11)
    expect(slices.filter((s) => s.name.includes('184 entries'))).toHaveLength(1)
    // 每条相位描述它自己那一小段：startTime 逐片前移 400（两次 now() + 检查 + 收尾），
    // duration 是该分片自己的墙钟——不是把各分片耗时累加成一个横跨让出间隙的伪连续 span。
    expect(slices[0]).toMatchObject({ startTime: 100, duration: 300 })
    expect(slices[1]!.startTime - slices[0]!.startTime).toBe(400)
    expect(slices.every((s) => s.duration === 300 || s.duration === 200)).toBe(true)
    const aggregate = getRecordedPhases().find((p) =>
      p.name.startsWith('mentionFileSearch.buildEntries'),
    )
    expect(aggregate).toBeUndefined()
  })

  it('records the async wall only when the load is actually slow', async () => {
    _resetPerfPhasesForTests()
    const root = URI.file('/repo')
    const slowFs = {
      _serviceBrand: undefined,
      async search() {
        // 墙钟含 IPC 等待：用一次真实的等待把它推过 50ms 记录线。
        await new Promise((resolve) => setTimeout(resolve, 120))
        return {
          relPaths: ['a.ts'],
          limitHit: false,
          filesWalked: 1,
          directoriesWalked: 1,
          durationMs: 0,
        }
      },
    } satisfies IFileSearchService

    await loadWorkspaceFiles(root, slowFs)
    const wall = getRecordedPhases().find((p) => p.name.startsWith('mentionFileSearch.loadWall'))
    expect(wall?.name).toContain('not cpu')
    expect(wall!.duration).toBeGreaterThanOrEqual(50)

    // 快路径（以及缓存命中）不记墙钟：这条量只在"卡顿期间清单加载在途"时有价值。
    _resetPerfPhasesForTests()
    await loadWorkspaceFiles(URI.file('/repo-fast'), fakeFileSearch(['/repo-fast/a.ts']))
    expect(
      getRecordedPhases().filter((p) => p.name.startsWith('mentionFileSearch.loadWall')),
    ).toHaveLength(0)
  })

  it('records no build sample for a small fast listing, and no wall sample on a cache hit', async () => {
    _resetPerfPhasesForTests()
    const root = URI.file('/repo')
    const fs = fakeFileSearch(['/repo/a.ts'])
    await loadWorkspaceFiles(root, fs)
    await loadWorkspaceFiles(root, fs)
    const phases = getRecordedPhases()
    expect(phases.filter((p) => p.name.includes('buildSlice'))).toHaveLength(0)
    expect(phases.filter((p) => p.name.includes('loadWall'))).toHaveLength(0)
  })
})

describe('filterMentionFiles', () => {
  const entries: readonly MentionFileEntry[] = [
    { uri: 'file:///r/src/main.ts', relPath: 'src/main.ts', name: 'main.ts' },
    { uri: 'file:///r/src/index.ts', relPath: 'src/index.ts', name: 'index.ts' },
    { uri: 'file:///r/test/main.test.ts', relPath: 'test/main.test.ts', name: 'main.test.ts' },
    { uri: 'file:///r/README.md', relPath: 'README.md', name: 'README.md' },
  ]

  it('returns the first `limit` entries for an empty query', () => {
    expect(filterMentionFiles(entries, '', 2)).toHaveLength(2)
  })

  it('ranks basename prefix matches above path-only matches', () => {
    const r = filterMentionFiles(entries, 'main')
    expect(r[0]?.name).toBe('main.ts')
    expect(r.map((e) => e.name)).toContain('main.test.ts')
  })

  it('matches via path substring when basename does not match', () => {
    const r = filterMentionFiles(entries, 'test/')
    expect(r.map((e) => e.relPath)).toEqual(['test/main.test.ts'])
  })

  it('is case-insensitive', () => {
    const r = filterMentionFiles(entries, 'README')
    expect(r[0]?.name).toBe('README.md')
  })

  it('falls back to subsequence match on path', () => {
    // 'srcidx' matches src/i...x via subsequence
    const r = filterMentionFiles(entries, 'srcidx')
    expect(r.some((e) => e.name === 'index.ts')).toBe(true)
  })

  it('filters out entries that do not match at all', () => {
    expect(filterMentionFiles(entries, 'zzzzz')).toEqual([])
  })

  it('respects the limit', () => {
    const many: MentionFileEntry[] = Array.from({ length: 50 }, (_, i) => ({
      uri: `file:///r/x${i}.ts`,
      relPath: `x${i}.ts`,
      name: `x${i}.ts`,
    }))
    expect(filterMentionFiles(many, 'x', 10)).toHaveLength(10)
  })
})
