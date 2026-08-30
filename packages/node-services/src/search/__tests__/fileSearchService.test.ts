/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for packages/node-services/src/search/fileSearchService.ts
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CancellationToken, CancellationTokenSource, URI } from '@universe-editor/platform'
import { FileSearchService } from '../fileSearchService.js'

const roots: string[] = []
const services: FileSearchService[] = []

async function makeRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'universe-file-search-'))
  roots.push(root)
  return root
}

// 缓存目录必须在工作区根之外，否则清单构建会把缓存文件自己也枚举进清单。
async function makeService(): Promise<FileSearchService> {
  const cacheDir = path.join(await makeRoot(), 'listings')
  const service = new FileSearchService(undefined, { cacheDir })
  services.push(service)
  return service
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
  for (const service of services.splice(0)) service.dispose()
  const prefix = path.resolve(os.tmpdir(), 'universe-file-search-')
  for (const root of roots.splice(0)) {
    const resolved = path.resolve(root)
    if (resolved.startsWith(prefix)) {
      await fs.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }
})

describe('FileSearchService', () => {
  it('uses maxResults as a result cap, not a candidate cap', async () => {
    const root = await makeRoot()
    await writeFile(root, 'first.txt')
    await writeFile(root, 'ActionDetailView.tsx')

    const service = await makeService()
    const complete = await service.search({
      root: URI.file(root),
      pattern: 'ActionDetailView.tsx',
      maxResults: 1,
    })

    expect(complete.results.map((r) => r.relativePath)).toEqual(['ActionDetailView.tsx'])
    expect(complete.limitHit).toBe(false)
  })

  it('matches path-shaped patterns across directory segments', async () => {
    const root = await makeRoot()
    await writeFile(root, 'src/main.ts')
    await writeFile(root, 'other/unrelated.ts')

    const service = await makeService()
    const complete = await service.search({
      root: URI.file(root),
      pattern: 'src/main',
      includeExactPathMatches: false,
      maxResults: 10,
    })

    expect(complete.results.map((r) => r.relativePath)).toEqual(['src/main.ts'])
  })

  it('reuses the on-disk listing across scored searches within the TTL', async () => {
    const root = await makeRoot()
    await writeFile(root, 'alpha.ts')
    await writeFile(root, 'beta.ts')

    const cacheDir = path.join(await makeRoot(), 'listings')
    const service = new FileSearchService(undefined, { cacheDir })
    services.push(service)

    const first = await service.search({ root: URI.file(root), pattern: 'alpha', maxResults: 10 })
    expect(first.results.map((r) => r.relativePath)).toEqual(['alpha.ts'])

    const second = await service.search({ root: URI.file(root), pattern: 'beta', maxResults: 10 })
    expect(second.results.map((r) => r.relativePath)).toEqual(['beta.ts'])

    // 同一 root+excludes 签名在 TTL 内只构建一次清单文件。
    const listings = (await fs.readdir(cacheDir)).filter((n) => n.endsWith('.list'))
    expect(listings).toHaveLength(1)
  })

  it('uses a distinct listing cache key per scan-path set', async () => {
    const root = await makeRoot()
    await writeFile(root, 'Client/a.ts')
    await writeFile(root, 'Engine/b.ts')

    const cacheDir = path.join(await makeRoot(), 'listings')
    const service = new FileSearchService(undefined, { cacheDir })
    services.push(service)

    await service.search({
      root: URI.file(root),
      pattern: 'a',
      scanPaths: ['Client'],
      maxResults: 10,
    })
    await service.search({
      root: URI.file(root),
      pattern: 'b',
      scanPaths: ['Engine'],
      maxResults: 10,
    })

    const listings = (await fs.readdir(cacheDir)).filter((n) => n.endsWith('.list'))
    expect(listings).toHaveLength(2)
  })

  it('enumerates only the given scan paths for matchAll', async () => {
    const root = await makeRoot()
    await writeFile(root, 'Client/a.ts')
    await writeFile(root, 'Engine/b.ts')

    const service = await makeService()
    const complete = await service.search({
      root: URI.file(root),
      pattern: '',
      matchAll: true,
      scanPaths: ['Client'],
      maxResults: 10,
    })

    expect(complete.results.map((r) => r.relativePath)).toEqual(['Client/a.ts'])
  })

  it('covers root files with rootFilesInScope without widening the scan', async () => {
    const root = await makeRoot()
    await writeFile(root, 'Client/a.ts')
    await writeFile(root, 'Engine/b.ts')
    await writeFile(root, 'README.md')

    const service = await makeService()
    const complete = await service.search({
      root: URI.file(root),
      pattern: '',
      matchAll: true,
      scanPaths: ['Client'],
      rootFilesInScope: true,
      maxResults: 10,
    })

    expect(complete.results.map((r) => r.relativePath).sort()).toEqual(['Client/a.ts', 'README.md'])
  })

  it('scores only files inside the scan paths', async () => {
    const root = await makeRoot()
    await writeFile(root, 'Client/main.ts')
    await writeFile(root, 'Engine/main.ts')

    const service = await makeService()
    const complete = await service.search({
      root: URI.file(root),
      pattern: 'main',
      scanPaths: ['Client'],
      maxResults: 10,
    })

    expect(complete.results.map((r) => r.relativePath)).toEqual(['Client/main.ts'])
  })

  it('finds root files through the listing when rootFilesInScope is set', async () => {
    const root = await makeRoot()
    await writeFile(root, 'Client/a.ts')
    await writeFile(root, 'README.md')

    const service = await makeService()
    const complete = await service.search({
      root: URI.file(root),
      pattern: 'README',
      scanPaths: ['Client'],
      rootFilesInScope: true,
      maxResults: 10,
    })

    expect(complete.results.map((r) => r.relativePath)).toEqual(['README.md'])
  })

  it('supports matchAll with search excludes and ignored directory names', async () => {
    const root = await makeRoot()
    await writeFile(root, 'src/main.ts')
    await writeFile(root, 'dist/generated.ts')
    await writeFile(root, 'node_modules/pkg/index.ts')

    const service = await makeService()
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

  it('applies excludes and ignored directory names to scored searches too', async () => {
    const root = await makeRoot()
    await writeFile(root, 'src/main.ts')
    await writeFile(root, 'dist/main.ts')
    await writeFile(root, 'node_modules/pkg/main.ts')

    const service = await makeService()
    const complete = await service.search({
      root: URI.file(root),
      pattern: 'main',
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

    const service = await makeService()
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

    const service = await makeService()
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

    const service = await makeService()
    const complete = await service.search({
      root: URI.file(root),
      pattern: '',
      matchAll: true,
      maxResults: 10,
    })

    expect(complete.results.map((r) => r.relativePath)).toEqual(['real.ts'])
  })

  describe('bounded accumulation', () => {
    it('stops the enumeration once matchAll accumulates maxResults', async () => {
      const root = await makeRoot()
      const writes: Promise<void>[] = []
      for (let dir = 0; dir < 20; dir++) {
        for (let file = 0; file < 10; file++) {
          writes.push(writeFile(root, `d${String(dir).padStart(2, '0')}/f${file}.ts`))
        }
      }
      await Promise.all(writes)

      const service = await makeService()
      const complete = await service.search({
        root: URI.file(root),
        pattern: '',
        matchAll: true,
        maxResults: 10,
      })

      expect(complete.results).toHaveLength(10)
      expect(complete.limitHit).toBe(true)
      // 枚举必须在 cap 处截断：没有截断的话 200 个文件全被累进内存
      //（曾经的主进程无界增长 OOM）。
      expect(complete.filesWalked).toBeLessThan(200)
    })

    it('keeps the global best matches when accumulation is compacted mid-search', async () => {
      const root = await makeRoot()
      const writes = [writeFile(root, 'fa.ts'), writeFile(root, 'faa.ts')]
      for (let i = 0; i < 300; i++) {
        writes.push(writeFile(root, `faaa-${String(i).padStart(3, '0')}.ts`))
      }
      await Promise.all(writes)

      const service = await makeService()
      const complete = await service.search({
        root: URI.file(root),
        pattern: 'f',
        maxResults: 2,
      })

      // maxResults 是结果页大小而非候选上限：全部 302 个候选都要参与打分，
      // 最终页必须是全局最优两条。
      expect(complete.filesWalked).toBe(302)
      expect(complete.results.map((r) => r.relativePath)).toEqual(['fa.ts', 'faa.ts'])
      expect(complete.limitHit).toBe(true)
    })
  })

  describe('cancellation and timeout', () => {
    it('returns immediately on an already-cancelled token', async () => {
      const root = await makeRoot()
      await writeFile(root, 'a.ts')

      const service = await makeService()
      const complete = await service.search(
        { root: URI.file(root), pattern: '', matchAll: true, maxResults: 10 },
        CancellationToken.Cancelled,
      )

      expect(complete.results).toEqual([])
      expect(complete.stopReason).toBe('canceled')
      expect(complete.limitHit).toBe(true)
      expect(complete.filesWalked).toBe(0)
    })

    it('stops the enumeration when cancelled mid-flight', async () => {
      const root = await makeRoot()
      const writes: Promise<void>[] = []
      for (let i = 0; i < 50; i++) {
        writes.push(writeFile(root, `f${i}.ts`))
      }
      await Promise.all(writes)

      const service = await makeService()
      const cts = new CancellationTokenSource()
      // rg 尚未产出任何数据事件前取消（spawn 后的 I/O 事件都在下一轮事件循环）。
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

    it('stops once the time budget is exhausted', async () => {
      const root = await makeRoot()
      await writeFile(root, 'a.ts')

      const service = await makeService()
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
    })
  })
})
