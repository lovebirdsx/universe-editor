/*---------------------------------------------------------------------------------------------
 *  Tests for the @-mention file search:
 *    - loadWorkspaceFiles caches per-URI and returns relative paths
 *    - filterMentionFiles ranks basename matches above path matches
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CancellationTokenSource,
  URI,
  type CancellationToken,
  type IFileSearchService,
} from '@universe-editor/platform'
import {
  filterMentionFiles,
  invalidateMentionFileCache,
  loadWorkspaceFiles,
  peekWorkspaceFiles,
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
