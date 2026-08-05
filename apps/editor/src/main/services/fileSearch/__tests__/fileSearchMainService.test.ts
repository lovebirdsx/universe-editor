/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for main-process workspace file-name search.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CancellationToken, CancellationTokenSource, URI } from '@universe-editor/platform'
import { FileSearchMainService } from '../fileSearchMainService.js'

const roots: string[] = []

async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'universe-file-search-'))
  roots.push(root)
  return root
}

async function writeFile(root: string, relPath: string): Promise<void> {
  const target = path.join(root, relPath)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, '')
}

async function trySymlink(
  target: string,
  linkPath: string,
  type: 'file' | 'dir',
): Promise<boolean> {
  try {
    await fs.symlink(target, linkPath, type)
    return true
  } catch {
    return false // Windows 无 symlink 权限 → 跳过
  }
}

afterEach(async () => {
  const prefix = path.resolve(os.tmpdir(), 'universe-file-search-')
  for (const root of roots.splice(0)) {
    const resolved = path.resolve(root)
    if (resolved.startsWith(prefix)) {
      await fs.rm(resolved, { recursive: true, force: true })
    }
  }
})

describe('FileSearchMainService', () => {
  it('uses maxResults as a result cap, not a traversal cap', async () => {
    const root = await makeRoot()
    await writeFile(root, 'first.txt')
    await writeFile(root, 'ActionDetailView.tsx')

    const service = new FileSearchMainService()
    const complete = await service.search({
      root: URI.file(root),
      pattern: 'ActionDetailView.tsx',
      maxResults: 1,
    })

    expect(complete.filesWalked).toBe(2)
    expect(complete.results.map((r) => r.relativePath)).toEqual(['ActionDetailView.tsx'])
  })

  it('supports matchAll with search excludes and ignored directory names', async () => {
    const root = await makeRoot()
    await writeFile(root, 'src/main.ts')
    await writeFile(root, 'dist/generated.ts')
    await writeFile(root, 'node_modules/pkg/index.ts')

    const service = new FileSearchMainService()
    const complete = await service.search({
      root: URI.file(root),
      pattern: '',
      matchAll: true,
      excludes: ['dist/**'],
      ignore: ['node_modules'],
      maxResults: 10,
    })

    expect(complete.results.map((r) => r.relativePath)).toEqual(['src/main.ts'])
  })

  it('finds a file symbolic link by following its target type', async () => {
    const root = await makeRoot()
    await writeFile(root, 'real.ts')
    if (!(await trySymlink(path.join(root, 'real.ts'), path.join(root, 'link.ts'), 'file'))) return

    const service = new FileSearchMainService()
    const complete = await service.search({
      root: URI.file(root),
      pattern: '',
      matchAll: true,
      maxResults: 10,
    })

    expect(complete.results.map((r) => r.relativePath).sort()).toEqual(['link.ts', 'real.ts'])
  })

  it('traverses a directory symbolic link', async () => {
    const root = await makeRoot()
    await writeFile(root, 'target/inside.ts')
    if (!(await trySymlink(path.join(root, 'target'), path.join(root, 'linkdir'), 'dir'))) return

    const service = new FileSearchMainService()
    const complete = await service.search({
      root: URI.file(root),
      pattern: 'inside.ts',
      maxResults: 10,
    })

    expect(complete.results.map((r) => r.relativePath).sort()).toEqual([
      'linkdir/inside.ts',
      'target/inside.ts',
    ])
  })

  it('skips a dangling symbolic link without throwing', async () => {
    const root = await makeRoot()
    await writeFile(root, 'real.ts')
    if (
      !(await trySymlink(path.join(root, 'does-not-exist'), path.join(root, 'broken.ts'), 'file'))
    )
      return

    const service = new FileSearchMainService()
    const complete = await service.search({
      root: URI.file(root),
      pattern: '',
      matchAll: true,
      maxResults: 10,
    })

    expect(complete.results.map((r) => r.relativePath)).toEqual(['real.ts'])
  })

  describe('bounded accumulation', () => {
    it('stops walking once matchAll accumulates maxResults', async () => {
      const root = await makeRoot()
      const writes: Promise<void>[] = []
      for (let dir = 0; dir < 20; dir++) {
        for (let file = 0; file < 10; file++) {
          writes.push(writeFile(root, `d${String(dir).padStart(2, '0')}/f${file}.ts`))
        }
      }
      await Promise.all(writes)

      const service = new FileSearchMainService()
      const complete = await service.search({
        root: URI.file(root),
        pattern: '',
        matchAll: true,
        maxResults: 10,
      })

      expect(complete.results).toHaveLength(10)
      expect(complete.limitHit).toBe(true)
      // The walk must short-circuit: without it every one of the 200 files is
      // accumulated in memory (the unbounded-growth main-process OOM).
      expect(complete.filesWalked).toBeLessThan(200)
    })

    it('keeps the global best matches when accumulation is compacted mid-walk', async () => {
      const root = await makeRoot()
      const writes = [writeFile(root, 'fa.ts'), writeFile(root, 'faa.ts')]
      for (let i = 0; i < 300; i++) {
        writes.push(writeFile(root, `faaa-${String(i).padStart(3, '0')}.ts`))
      }
      await Promise.all(writes)

      const service = new FileSearchMainService()
      const complete = await service.search({
        root: URI.file(root),
        pattern: 'f',
        maxResults: 2,
      })

      // Scoring walks the whole tree (maxResults is a result cap, not a
      // traversal cap) but must still surface the two globally best matches.
      expect(complete.filesWalked).toBe(302)
      expect(complete.results.map((r) => r.relativePath)).toEqual(['fa.ts', 'faa.ts'])
      expect(complete.limitHit).toBe(true)
    })
  })

  describe('cancellation and timeout', () => {
    it('returns immediately on an already-cancelled token', async () => {
      const root = await makeRoot()
      await writeFile(root, 'a.ts')

      const service = new FileSearchMainService()
      const complete = await service.search(
        { root: URI.file(root), pattern: '', matchAll: true, maxResults: 10 },
        CancellationToken.Cancelled,
      )

      expect(complete.results).toEqual([])
      expect(complete.stopReason).toBe('canceled')
      expect(complete.limitHit).toBe(true)
      expect(complete.filesWalked).toBe(0)
      expect(complete.directoriesWalked).toBe(0)
    })

    it('stops the walk when cancelled mid-flight', async () => {
      const root = await makeRoot()
      const writes: Promise<void>[] = []
      for (let i = 0; i < 50; i++) {
        writes.push(writeFile(root, `f${i}.ts`))
      }
      await Promise.all(writes)

      const service = new FileSearchMainService()
      const cts = new CancellationTokenSource()
      // Cancel after the walk has started (it is parked on the first readdir).
      const pending = service.search(
        { root: URI.file(root), pattern: '', matchAll: true, maxResults: 100 },
        cts.token,
      )
      cts.cancel()
      const complete = await pending

      expect(complete.stopReason).toBe('canceled')
      expect(complete.limitHit).toBe(true)
      expect(complete.filesWalked).toBe(0)
    })

    it('stops the walk once the time budget is exhausted', async () => {
      const root = await makeRoot()
      await writeFile(root, 'a.ts')

      const service = new FileSearchMainService()
      const complete = await service.search({
        root: URI.file(root),
        pattern: '',
        matchAll: true,
        maxResults: 10,
        timeoutMs: 0,
      })

      expect(complete.stopReason).toBe('timeout')
      expect(complete.limitHit).toBe(true)
      expect(complete.filesWalked).toBe(0)
      expect(complete.directoriesWalked).toBe(0)
    })
  })
})
