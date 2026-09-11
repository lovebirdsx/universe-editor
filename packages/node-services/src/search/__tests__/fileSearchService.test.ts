/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for packages/node-services/src/search/fileSearchService.ts
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  CancellationToken,
  CancellationTokenSource,
  URI,
  type IFileSearchComplete,
  type IFileSearchListing,
  type IFileSearchMatches,
} from '@universe-editor/platform'
import { FileSearchService } from '../fileSearchService.js'
import { mkTempDir, effectiveTempRoot } from '@universe-editor/temp-root'

/** The listing and scored shapes share no identifying field — discriminate loudly. */
function asListing(complete: IFileSearchComplete): IFileSearchListing {
  if (!('relPaths' in complete)) throw new Error('expected a listing result')
  return complete
}

function asMatches(complete: IFileSearchComplete): IFileSearchMatches {
  if (!('results' in complete)) throw new Error('expected a scored result')
  return complete
}

const roots: string[] = []
const services: FileSearchService[] = []

async function makeRoot(): Promise<string> {
  const root = mkTempDir('universe-file-search-')
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
  const prefix = path.resolve(effectiveTempRoot(), 'universe-file-search-')
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

    expect(asMatches(complete).results.map((r) => r.relativePath)).toEqual(['ActionDetailView.tsx'])
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

    expect(asMatches(complete).results.map((r) => r.relativePath)).toEqual(['src/main.ts'])
  })

  it('reuses the on-disk listing across scored searches within the TTL', async () => {
    const root = await makeRoot()
    await writeFile(root, 'alpha.ts')
    await writeFile(root, 'beta.ts')

    const cacheDir = path.join(await makeRoot(), 'listings')
    const service = new FileSearchService(undefined, { cacheDir })
    services.push(service)

    const first = await service.search({ root: URI.file(root), pattern: 'alpha', maxResults: 10 })
    expect(asMatches(first).results.map((r) => r.relativePath)).toEqual(['alpha.ts'])

    const second = await service.search({ root: URI.file(root), pattern: 'beta', maxResults: 10 })
    expect(asMatches(second).results.map((r) => r.relativePath)).toEqual(['beta.ts'])

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

  it('uses a distinct listing cache key per useIgnoreFiles value', async () => {
    const root = await makeRoot()
    await writeFile(root, 'a.ts')

    const cacheDir = path.join(await makeRoot(), 'listings')
    const service = new FileSearchService(undefined, { cacheDir })
    services.push(service)

    const query = { root: URI.file(root), pattern: 'a', maxResults: 10 }
    await service.search({ ...query, useIgnoreFiles: true })
    await service.search({ ...query, useIgnoreFiles: false })

    // Sharing one listing between the two settings would serve the other
    // setting's file set for the whole TTL.
    const listings = (await fs.readdir(cacheDir)).filter((n) => n.endsWith('.list'))
    expect(listings).toHaveLength(2)
  })

  it('honours .gitignore only when useIgnoreFiles is set', async () => {
    const root = await makeRoot()
    await writeFile(root, 'keep.ts')
    await writeFile(root, 'build/ignored.ts')
    await fs.writeFile(path.join(root, '.gitignore'), 'build/\n')

    const query = { root: URI.file(root), pattern: '', matchAll: true, maxResults: 50 }

    const honouring = await (await makeService()).search({ ...query, useIgnoreFiles: true })
    expect(asListing(honouring).relPaths).not.toContain('build/ignored.ts')

    const ignoring = await (await makeService()).search({ ...query, useIgnoreFiles: false })
    expect(asListing(ignoring).relPaths).toContain('build/ignored.ts')
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

    expect(asListing(complete).relPaths).toEqual(['Client/a.ts'])
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

    expect([...asListing(complete).relPaths].sort()).toEqual(['Client/a.ts', 'README.md'])
  })

  it('enumerates nothing for an empty scanPaths without rootFilesInScope', async () => {
    const root = await makeRoot()
    await writeFile(root, 'Client/a.ts')
    await writeFile(root, 'README.md')

    const service = await makeService()
    const complete = await service.search({
      root: URI.file(root),
      pattern: '',
      matchAll: true,
      scanPaths: [],
      maxResults: 10,
    })

    // 空数组是「聚焦但无可扫路径」的显式信号，绝不能回退成全量枚举。
    expect(asListing(complete).relPaths).toEqual([])
  })

  it('enumerates only root files for an empty scanPaths with rootFilesInScope', async () => {
    const root = await makeRoot()
    await writeFile(root, 'Client/a.ts')
    await writeFile(root, 'README.md')

    const service = await makeService()
    const complete = await service.search({
      root: URI.file(root),
      pattern: '',
      matchAll: true,
      scanPaths: [],
      rootFilesInScope: true,
      maxResults: 10,
    })

    expect(asListing(complete).relPaths).toEqual(['README.md'])
  })

  it('uses a distinct listing cache key for empty versus absent scanPaths', async () => {
    const root = await makeRoot()
    await writeFile(root, 'Client/a.ts')
    await writeFile(root, 'README.md')

    const cacheDir = path.join(await makeRoot(), 'listings')
    const service = new FileSearchService(undefined, { cacheDir })
    services.push(service)

    // 未聚焦（scanPaths 缺席）与聚焦无可扫（[]）是两个语义状态：前者枚举
    // 整个工作区，后者只剩根文件。共享缓存键会把全量清单错发给聚焦查询。
    const focused = await service.search({
      root: URI.file(root),
      pattern: 'a',
      scanPaths: [],
      rootFilesInScope: true,
      maxResults: 10,
    })
    expect(asMatches(focused).results.map((r) => r.relativePath)).toEqual(['README.md'])

    const unfocused = await service.search({
      root: URI.file(root),
      pattern: 'a',
      rootFilesInScope: true,
      maxResults: 10,
    })
    expect(
      asMatches(unfocused)
        .results.map((r) => r.relativePath)
        .sort(),
    ).toEqual(['Client/a.ts', 'README.md'])

    const listings = (await fs.readdir(cacheDir)).filter((n) => n.endsWith('.list'))
    expect(listings).toHaveLength(2)
  })

  it('scores nothing for an empty scanPaths even when the pattern matches root files', async () => {
    const root = await makeRoot()
    await writeFile(root, 'Client/main.ts')
    await writeFile(root, 'main.md')

    const service = await makeService()
    const complete = await service.search({
      root: URI.file(root),
      pattern: 'main',
      scanPaths: [],
      maxResults: 10,
    })

    expect(asMatches(complete).results).toEqual([])
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

    expect(asMatches(complete).results.map((r) => r.relativePath)).toEqual(['Client/main.ts'])
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

    expect(asMatches(complete).results.map((r) => r.relativePath)).toEqual(['README.md'])
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

    expect(asListing(complete).relPaths).toEqual(['src/main.ts'])
  })

  it('filters the matchAll enumeration by glob', async () => {
    const root = await makeRoot()
    await writeFile(root, 'tsconfig.json')
    await writeFile(root, 'packages/app/tsconfig.build.json')
    await writeFile(root, 'src/main.ts')

    const service = await makeService()
    const complete = await service.search({
      root: URI.file(root),
      pattern: '',
      matchAll: true,
      glob: ['tsconfig*.json'],
      maxResults: 50,
    })

    // 没有 glob 的话，调用方得先把整个工作区读进来再按文件名过滤。
    expect([...asListing(complete).relPaths].sort()).toEqual([
      'packages/app/tsconfig.build.json',
      'tsconfig.json',
    ])
  })

  it('matches glob case-insensitively so case variants are not silently dropped', async () => {
    const root = await makeRoot()
    // 只写大小写变体，不写小写正主：rg 的 `-g` 是大小写敏感的，正向预筛若用 `-g`
    // 会在这里静默漏掉 `TsConfig.json`——后置的 /i 正则根本救不回枚举阶段丢的文件。
    await writeFile(root, 'TsConfig.json')

    const service = await makeService()
    const complete = await service.search({
      root: URI.file(root),
      pattern: '',
      matchAll: true,
      glob: ['tsconfig*.json'],
      maxResults: 10,
    })

    expect(asListing(complete).relPaths).toEqual(['TsConfig.json'])
  })

  it('keeps excludes effective alongside a glob (rg --iglob overrides -g regardless of order)', async () => {
    const root = await makeRoot()
    await writeFile(root, 'tsconfig.json')
    await writeFile(root, 'tsconfig.build.json')
    await writeFile(root, 'src/main.ts')

    const service = await makeService()
    const complete = await service.search({
      root: URI.file(root),
      pattern: '',
      matchAll: true,
      glob: ['tsconfig*.json'],
      // rg 15：`--iglob` 集合恒定压过 `-g` 集合（与命令行顺序无关）。负向排除若仍发
      // `-g '!...'`，被正向 --iglob 命中的 tsconfig.build.json 会被白名单复活。
      excludes: ['tsconfig.build.json'],
      maxResults: 10,
    })

    expect(asListing(complete).relPaths).toEqual(['tsconfig.json'])
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

    expect(asMatches(complete).results.map((r) => r.relativePath)).toEqual(['src/main.ts'])
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

    expect([...asListing(complete).relPaths].sort()).toEqual(['link.ts', 'real.ts'])
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

    expect(
      asMatches(complete)
        .results.map((r) => r.relativePath)
        .sort(),
    ).toEqual(['linkdir/inside.ts', 'target/inside.ts'])
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

    expect(asListing(complete).relPaths).toEqual(['real.ts'])
  })

  describe('listing cache hygiene', () => {
    const exists = (p: string) =>
      fs
        .stat(p)
        .then(() => true)
        .catch(() => false)

    async function seed(cacheDir: string, name: string, bytes: number, ageMs: number) {
      const filePath = path.join(cacheDir, name)
      await fs.writeFile(filePath, 'x'.repeat(bytes))
      const when = new Date(Date.now() - ageMs)
      await fs.utimes(filePath, when, when)
      return filePath
    }

    // 长驻编辑器不会重启，构造时扫一次等于永不回收——8 GB 就是这么攒出来的。
    it('sweeps again on the periodic timer, not just at construction', async () => {
      vi.useFakeTimers()
      try {
        const cacheDir = path.join(await makeRoot(), 'listings')
        await fs.mkdir(cacheDir, { recursive: true })
        const service = new FileSearchService(undefined, { cacheDir })
        services.push(service)

        const stale = await seed(cacheDir, 'aaaa1111-1.list', 10, 8 * 24 * 60 * 60_000)
        await vi.advanceTimersByTimeAsync(6 * 60 * 60_000 + 10)
        await vi.waitFor(async () => expect(await exists(stale)).toBe(false))
      } finally {
        vi.useRealTimers()
      }
    })

    it('evicts oldest listings first once the cache exceeds its byte budget', async () => {
      const cacheDir = path.join(await makeRoot(), 'listings')
      await fs.mkdir(cacheDir, { recursive: true })
      const oldest = await seed(cacheDir, 'aaaa1111-1.list', 400, 3 * 60_000)
      const middle = await seed(cacheDir, 'bbbb2222-1.list', 400, 2 * 60_000)
      const newest = await seed(cacheDir, 'cccc3333-1.list', 400, 60_000)
      // 半成品不参与预算淘汰：删掉会毁掉另一个进程正在建的清单
      const building = await seed(cacheDir, 'dddd4444-1.building', 400, 4 * 60_000)

      const service = new FileSearchService(undefined, { cacheDir, listingCacheBudgetBytes: 900 })
      services.push(service)

      await vi.waitFor(async () => expect(await exists(oldest)).toBe(false))
      expect(await exists(middle)).toBe(true)
      expect(await exists(newest)).toBe(true)
      expect(await exists(building)).toBe(true)
    })
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

      expect(asListing(complete).relPaths).toHaveLength(10)
      expect(complete.limitHit).toBe(true)
      // 枚举必须在 cap 处截断：没有截断的话 200 个文件全被累进内存
      //（曾经的主进程无界增长 OOM）。
      expect(complete.filesWalked).toBeLessThan(200)
    })

    it('omits a truncated listing when the caller cannot use a subset', async () => {
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
        omitTruncatedListing: true,
      })

      // 十万条路径跨 IPC 正是巨型工作区堵住 renderer 主线程的原因；调用方
      // 用不了残缺子集，所以整份丢弃 —— 但截断信号必须照常返回。
      expect(asListing(complete).relPaths).toEqual([])
      expect(complete.limitHit).toBe(true)
    })

    it('keeps a complete listing even with omitTruncatedListing set', async () => {
      const root = await makeRoot()
      await writeFile(root, 'a.ts')

      const service = await makeService()
      const complete = await service.search({
        root: URI.file(root),
        pattern: '',
        matchAll: true,
        maxResults: 10,
        omitTruncatedListing: true,
      })

      expect(asListing(complete).relPaths).toEqual(['a.ts'])
      expect(complete.limitHit).toBe(false)
    })

    it('omits a timed-out listing too, and still warms the disk listing', async () => {
      const root = await makeRoot()
      await writeFile(root, 'a.ts')

      const cacheDir = path.join(await makeRoot(), 'listings')
      const service = new FileSearchService(undefined, { cacheDir })
      services.push(service)

      // timeoutMs: 0 → 走查在开跑前就超时：没有 capped，但同样没走完。
      const complete = await service.search({
        root: URI.file(root),
        pattern: '',
        matchAll: true,
        maxResults: 10,
        timeoutMs: 0,
        omitTruncatedListing: true,
      })

      expect(asListing(complete).relPaths).toEqual([])
      expect(complete.stopReason).toBe('timeout')

      // 超时也要预热磁盘清单：否则第一次交互式兜底搜索会在自己的调用里等完
      // 整个构建（巨型工作区分钟级）。这里不做打分搜索，直接等清单落盘。
      await vi.waitFor(async () => {
        const listings = (await fs.readdir(cacheDir)).filter((n) => n.endsWith('.list'))
        expect(listings).toHaveLength(1)
      })
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
      expect(asMatches(complete).results.map((r) => r.relativePath)).toEqual(['fa.ts', 'faa.ts'])
      expect(complete.limitHit).toBe(true)
    })
  })

  describe('cold-listing wait', () => {
    it('clamps the cold-listing wait to listingWaitMs, not the query deadline', async () => {
      const root = await makeRoot()
      await writeFile(root, 'alpha.ts')

      const cacheDir = path.join(await makeRoot(), 'listings')
      const service = new FileSearchService(undefined, { cacheDir, listingWaitMs: 1 })
      services.push(service)

      // 查询自己有 60s，清单等待上限被钳到 1ms —— 必须在上限处收兵，而不是待在
      // _ensureListingForQuery 里等整个构建（大工作区 30s+）。用 1ms 而非 0 避免
      // setTimeout(0) 与 building.then 微任务的竞态倒向另一边。
      const complete = await service.search({
        root: URI.file(root),
        pattern: 'alpha',
        maxResults: 10,
        timeoutMs: 60_000,
      })
      expect(complete.stopReason).toBe('timeout')
      expect(complete.limitHit).toBe(true)

      // 清单后台仍建好：下一次击键就能命中。
      await vi.waitFor(async () => {
        const listings = (await fs.readdir(cacheDir)).filter((n) => n.endsWith('.list'))
        expect(listings).toHaveLength(1)
      })
      const second = await service.search({
        root: URI.file(root),
        pattern: 'alpha',
        maxResults: 10,
        timeoutMs: 60_000,
      })
      expect(asMatches(second).results.map((r) => r.relativePath)).toEqual(['alpha.ts'])
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

      expect(asListing(complete).relPaths).toEqual([])
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
