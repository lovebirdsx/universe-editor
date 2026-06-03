/*---------------------------------------------------------------------------------------------
 *  Tests for the @-mention file search:
 *    - loadWorkspaceFiles caches per-URI and returns relative paths
 *    - filterMentionFiles ranks basename matches above path matches
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { URI, type IFileSearchService } from '@universe-editor/platform'
import {
  filterMentionFiles,
  invalidateMentionFileCache,
  loadWorkspaceFiles,
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

function fakeFileSearch(paths: readonly string[]): IFileSearchService {
  return {
    _serviceBrand: undefined,
    async search(query) {
      return {
        results: paths.map((abs) => {
          const rel = relativePath(query.root, abs)
          const name = rel.split('/').pop() ?? rel
          return {
            resource: URI.file(abs).toJSON(),
            fsPath: abs,
            relativePath: rel,
            basename: name,
            score: 0,
          }
        }),
        limitHit: false,
        filesWalked: paths.length,
        directoriesWalked: 1,
        durationMs: 0,
      }
    },
  }
}

describe('loadWorkspaceFiles', () => {
  it('returns entries with workspace-relative paths', async () => {
    const root = URI.file('/repo')
    const fs = fakeFileSearch(['/repo/src/main.ts', '/repo/README.md'])
    const entries = await loadWorkspaceFiles(root, fs)
    expect(entries.map((e) => e.relPath).sort()).toEqual(['README.md', 'src/main.ts'])
    expect(entries.find((e) => e.relPath === 'src/main.ts')?.name).toBe('main.ts')
    expect(entries.find((e) => e.relPath === 'src/main.ts')?.uri).toBe(
      URI.file('/repo/src/main.ts').toString(),
    )
  })

  it('normalizes Windows-style paths to forward slashes', async () => {
    const root = URI.file('C:/repo')
    const fs = fakeFileSearch(['C:\\repo\\src\\main.ts'])
    const entries = await loadWorkspaceFiles(root, fs)
    expect(entries[0]?.relPath).toBe('src/main.ts')
  })

  it('caches results within the TTL window', async () => {
    const root = URI.file('/repo')
    let calls = 0
    const fs = {
      _serviceBrand: undefined,
      async search() {
        calls++
        return {
          results: [
            {
              resource: URI.file('/repo/a.ts').toJSON(),
              fsPath: '/repo/a.ts',
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
    } satisfies IFileSearchService
    await loadWorkspaceFiles(root, fs)
    await loadWorkspaceFiles(root, fs)
    expect(calls).toBe(1)
  })

  it('invalidateMentionFileCache forces a re-walk', async () => {
    const root = URI.file('/repo')
    let calls = 0
    const fs = {
      _serviceBrand: undefined,
      async search() {
        calls++
        return {
          results: [
            {
              resource: URI.file('/repo/a.ts').toJSON(),
              fsPath: '/repo/a.ts',
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
    } satisfies IFileSearchService
    await loadWorkspaceFiles(root, fs)
    invalidateMentionFileCache(root)
    await loadWorkspaceFiles(root, fs)
    expect(calls).toBe(2)
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
