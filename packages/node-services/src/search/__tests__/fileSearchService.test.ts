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
import { effectiveTempRoot, mkTempDir, removeDirWithRetry } from '@universe-editor/temp-root'

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

interface Internals {
  _buildChain: Promise<void>
  _entryFor(spec: unknown): { key: string; file?: { builtAt: number }; building?: unknown }
  _build(entry: unknown, spec: unknown, claim: boolean): Promise<unknown>
  _runBuild(...args: unknown[]): Promise<unknown>
  _collectToFile(...args: unknown[]): Promise<unknown>
}

function internals(service: FileSearchService): Internals {
  return service as unknown as Internals
}

function specFor(root: string, ignore: string[] = []) {
  return {
    rootFsPath: root,
    excludes: [],
    ignore,
    maxDepth: 30,
    scanPaths: undefined,
    rootFilesInScope: false,
    useIgnoreFiles: false,
    glob: undefined,
  }
}

/** Replace the rg walk with a budget-killed one that wrote `content`. */
function mockBudgetKill(service: FileSearchService, content: string) {
  return vi.spyOn(internals(service), '_collectToFile').mockImplementation(async (fh: unknown) => {
    if (content) await (fh as { write(s: string): Promise<unknown> }).write(content)
    return { code: null, stderr: '', budget: 'size' }
  })
}

function buildSpy(service: FileSearchService) {
  return vi.spyOn(
    service as unknown as { _runBuild: (...args: unknown[]) => Promise<unknown> },
    '_runBuild',
  )
}

async function listingNames(cacheDir: string): Promise<string[]> {
  // 缓存目录尚未创建 = 一份清单都没建过。
  const names = await fs.readdir(cacheDir).catch(() => [] as string[])
  return names.filter((n) => n.endsWith('.list'))
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
      removeDirWithRetry(resolved)
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

    it('omits a timed-out listing too, without warming the disk listing', async () => {
      const root = await makeRoot()
      await writeFile(root, 'a.ts')

      const cacheDir = path.join(await makeRoot(), 'listings')
      const service = new FileSearchService(undefined, { cacheDir })
      services.push(service)
      const build = vi.spyOn(internals(service), '_build')

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

      // 自动预热超时不得替它拉起全树构建：巨型工作区上那是分钟级的满核 rg。
      // 等过磁盘探测那一跳，旧实现的预热就挂在它后面。
      await new Promise((r) => setTimeout(r, 50))
      expect(build).not.toHaveBeenCalled()
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

  describe('matchAll include filtering', () => {
    it('finds the match behind a wall of unrelated entries (they never consume the cap)', async () => {
      const root = await makeRoot()
      const writes: Promise<void>[] = []
      for (let dir = 0; dir < 30; dir++) {
        for (let file = 0; file < 10; file++) {
          writes.push(writeFile(root, `gen/d${dir}/f${file}.ts`))
        }
      }
      writes.push(writeFile(root, 'zz-keep/tsconfig.json'))
      await Promise.all(writes)

      const service = await makeService()
      const complete = await service.search({
        root: URI.file(root),
        pattern: '',
        matchAll: true,
        includeGlob: 'tsconfig*.json',
        maxResults: 5,
      })

      // 过滤若发生在 cap 之后，300 个无关文件会把结果整份吃掉（只剩 gen/*.ts）。
      expect(asListing(complete).relPaths).toEqual(['zz-keep/tsconfig.json'])
      expect(complete.limitHit).toBe(false)
      expect(complete.filesWalked).toBeGreaterThanOrEqual(1)
    })

    it('counts the cap against matching entries, not scanned ones', async () => {
      const root = await makeRoot()
      const writes: Promise<void>[] = []
      for (let i = 0; i < 200; i++) writes.push(writeFile(root, `gen/f${i}.ts`))
      writes.push(writeFile(root, 'a.json'), writeFile(root, 'b.json'), writeFile(root, 'c.json'))
      await Promise.all(writes)

      const service = await makeService()
      const complete = await service.search({
        root: URI.file(root),
        pattern: '',
        matchAll: true,
        includeGlob: '*.json',
        maxResults: 2,
      })

      expect(asListing(complete).relPaths).toHaveLength(2)
      expect(asListing(complete).relPaths.every((relPath) => relPath.endsWith('.json'))).toBe(true)
      expect(complete.limitHit).toBe(true)
      expect(complete.stopReason).toBe('maxResults')
      // scanned 记的是扫过的行数（含被过滤掉的），与命中数分开记账。
      expect(complete.filesWalked).toBeGreaterThanOrEqual(2)
    })

    it('applies the extension glob semantics (brace / class / case)', async () => {
      const root = await makeRoot()
      await writeFile(root, 'src/a.ts')
      await writeFile(root, 'src/b.tsx')
      await writeFile(root, 'src/c.js')
      await writeFile(root, 'src/D.TS')

      const service = await makeService()
      const query = { root: URI.file(root), pattern: '', matchAll: true, maxResults: 50 }

      const braces = await service.search({ ...query, includeGlob: '**/*.{ts,tsx}' })
      expect([...asListing(braces).relPaths].sort()).toEqual(['src/a.ts', 'src/b.tsx'])

      const charClass = await service.search({ ...query, includeGlob: 'src/[ab].ts' })
      expect(asListing(charClass).relPaths).toEqual(['src/a.ts'])

      // 扩展语义大小写敏感：`*.ts` 不匹配 `D.TS`（预筛的 --iglob 是大小写不敏感的，
      // 所以含 includeGlob 的请求绝不能把过滤下放给 rg --iglob）。
      const caseSensitive = await service.search({ ...query, includeGlob: '*.ts' })
      expect(asListing(caseSensitive).relPaths).toEqual(['src/a.ts'])
    })

    it('keeps ignore-file and exclude semantics untouched while filtering', async () => {
      const root = await makeRoot()
      await writeFile(root, 'keep/a.json')
      await writeFile(root, 'ignored/b.json')
      await writeFile(root, 'skip/c.json')
      await fs.writeFile(path.join(root, '.gitignore'), 'ignored/\n')

      const service = await makeService()
      const complete = await service.search({
        root: URI.file(root),
        pattern: '',
        matchAll: true,
        includeGlob: '*.json',
        excludes: ['skip/**'],
        useIgnoreFiles: true,
        maxResults: 50,
      })

      expect(asListing(complete).relPaths).toEqual(['keep/a.json'])
    })

    it('filters the root-files pass with the same include glob', async () => {
      const root = await makeRoot()
      await writeFile(root, 'Client/a.json')
      await writeFile(root, 'Client/b.ts')
      await writeFile(root, 'README.json')
      await writeFile(root, 'root.ts')

      const service = await makeService()
      const complete = await service.search({
        root: URI.file(root),
        pattern: '',
        matchAll: true,
        includeGlob: '*.json',
        scanPaths: ['Client'],
        rootFilesInScope: true,
        maxResults: 10,
      })

      expect([...asListing(complete).relPaths].sort()).toEqual(['Client/a.json', 'README.json'])
    })

    it('returns an empty listing for an already-cancelled token', async () => {
      const root = await makeRoot()
      await writeFile(root, 'a.json')

      const service = await makeService()
      const complete = await service.search(
        {
          root: URI.file(root),
          pattern: '',
          matchAll: true,
          includeGlob: '*.json',
          maxResults: 10,
        },
        CancellationToken.Cancelled,
      )

      expect(asListing(complete).relPaths).toEqual([])
      expect(complete.stopReason).toBe('canceled')
    })

    it('does not build a disk listing for a capped matchAll walk', async () => {
      const root = await makeRoot()
      const writes: Promise<void>[] = []
      for (let i = 0; i < 20; i++) writes.push(writeFile(root, `gen/f${i}.ts`))
      await Promise.all(writes)

      const service = await makeService()
      const build = buildSpy(service)

      const complete = await service.search({
        root: URI.file(root),
        pattern: '',
        matchAll: true,
        maxResults: 3,
      })
      expect(complete.limitHit).toBe(true)
      // 清单只由交互式打分查询按需构建（诊断包：预热与 tsconfig 枚举各拉一个满核 rg）。
      expect(build).not.toHaveBeenCalled()
    })
  })

  describe('listing build scheduling', () => {
    it('runs at most one listing build at a time across keys', async () => {
      const root = await makeRoot()
      await writeFile(root, 'alpha.ts')
      await writeFile(root, 'sub/beta.ts')

      const cacheDir = path.join(await makeRoot(), 'listings')
      const service = new FileSearchService(undefined, { cacheDir })
      services.push(service)
      const inner = service as unknown as {
        _runBuild: (...args: unknown[]) => Promise<unknown>
      }
      const original = inner._runBuild.bind(service)
      let running = 0
      let peak = 0
      vi.spyOn(inner, '_runBuild').mockImplementation(async (...args: unknown[]) => {
        running++
        peak = Math.max(peak, running)
        try {
          return await original(...args)
        } finally {
          running--
        }
      })

      // 两个不同 root（不同 key、不互相取代）同时冷启动打分查询。
      const other = await makeRoot()
      await writeFile(other, 'alpha.ts')
      const results = await Promise.all([
        service.search({ root: URI.file(root), pattern: 'alpha', maxResults: 10 }),
        service.search({ root: URI.file(other), pattern: 'alpha', maxResults: 10 }),
      ])
      for (const r of results) {
        expect(asMatches(r).results.map((m) => m.relativePath)).toEqual(['alpha.ts'])
      }
      expect(peak).toBe(1)
    })

    it('skips a queued build superseded by a newer claim for the same root', async () => {
      const root = await makeRoot()
      await writeFile(root, 'alpha.ts')
      const service = await makeService()
      const svc = internals(service)
      // 卡住队头，确定性地让后面的构建全部排队（不依赖 fs 回调顺序）。
      let release!: () => void
      svc._buildChain = new Promise<void>((r) => (release = r))

      const specA = specFor(root)
      const specB = specFor(root, ['skip'])
      const a = svc._build(svc._entryFor(specA), specA, true)
      const b = svc._build(svc._entryFor(specB), specB, true)
      // A 被再次请求：它重新成为最新，排在前面也不能被 B 挤掉。
      const a2 = svc._build(svc._entryFor(specA), specA, true)
      expect(a2).toBe(a)
      release()

      expect(await a).not.toBeNull()
      expect(await b).toBeNull()
    })

    it('does not let a stale revalidation supersede a waited-for build', async () => {
      const root = await makeRoot()
      await writeFile(root, 'alpha.ts')
      const service = await makeService()
      const svc = internals(service)
      let release!: () => void
      svc._buildChain = new Promise<void>((r) => (release = r))

      const specA = specFor(root)
      const specB = specFor(root, ['skip'])
      const waited = svc._build(svc._entryFor(specB), specB, true)
      const revalidate = svc._build(svc._entryFor(specA), specA, false)
      release()

      expect(await waited).not.toBeNull()
      // 保鲜重建不认领 root，且 root 已被别的 key 认领：放弃，不走树。
      expect(await revalidate).toBeNull()
    })

    it('keeps an existing complete listing when a rebuild exceeds the budget', async () => {
      const root = await makeRoot()
      await writeFile(root, 'alpha.ts')
      await writeFile(root, 'beta.ts')
      const cacheDir = path.join(await makeRoot(), 'listings')
      const service = new FileSearchService(undefined, { cacheDir })
      services.push(service)
      await service.search({ root: URI.file(root), pattern: 'alpha', maxResults: 5 })
      const [complete] = await listingNames(cacheDir)

      mockBudgetKill(service, 'alpha.ts\n')
      const svc = internals(service)
      const spec = specFor(root, [])
      const rebuilt = (await svc._build(svc._entryFor(spec), spec, true)) as {
        filePath: string
        partial: boolean
      }
      // 旧的完整清单比新的残缺前缀更有用：保留并续期，残缺的不落盘。
      expect(rebuilt.partial).toBe(false)
      expect(path.basename(rebuilt.filePath)).toBe(complete)
      expect(await listingNames(cacheDir)).toEqual([complete])
      const again = await service.search({ root: URI.file(root), pattern: 'beta', maxResults: 5 })
      expect(asMatches(again).results.map((r) => r.relativePath)).toEqual(['beta.ts'])
    })

    it('does not cache an empty budget-killed listing', async () => {
      const root = await makeRoot()
      await writeFile(root, 'alpha.ts')
      const cacheDir = path.join(await makeRoot(), 'listings')
      const service = new FileSearchService(undefined, { cacheDir })
      services.push(service)
      const collect = mockBudgetKill(service, '')

      const first = await service.search({ root: URI.file(root), pattern: 'alpha', maxResults: 5 })
      expect(first.stopReason).toBe('timeout')
      expect(await listingNames(cacheDir)).toEqual([])
      // 没有被当成 30 分钟的残缺缓存：下一次查询重新尝试构建。
      collect.mockRestore()
      const second = await service.search({ root: URI.file(root), pattern: 'alpha', maxResults: 5 })
      expect(asMatches(second).results.map((r) => r.relativePath)).toEqual(['alpha.ts'])
    })

    it('prefers a complete listing on disk over a newer partial one', async () => {
      const root = await makeRoot()
      await writeFile(root, 'alpha.ts')
      await writeFile(root, 'beta.ts')
      const cacheDir = path.join(await makeRoot(), 'listings')
      const first = new FileSearchService(undefined, { cacheDir })
      services.push(first)
      await first.search({ root: URI.file(root), pattern: 'alpha', maxResults: 5 })
      const [complete] = await listingNames(cacheDir)
      const key = complete!.slice(0, complete!.indexOf('-'))
      const partial = `${key}-9999999999999.partial.list`
      await fs.writeFile(path.join(cacheDir, partial), 'alpha.ts\n')

      const second = new FileSearchService(undefined, { cacheDir })
      services.push(second)
      const result = await second.search({ root: URI.file(root), pattern: 'beta', maxResults: 5 })
      expect(asMatches(result).results.map((r) => r.relativePath)).toEqual(['beta.ts'])
      await vi.waitFor(async () => expect(await listingNames(cacheDir)).toEqual([complete]))
    })

    it('warms the disk listing only for a truncated walk that asks for it', async () => {
      const root = await makeRoot()
      const writes: Promise<void>[] = []
      for (let i = 0; i < 20; i++) writes.push(writeFile(root, `gen/f${i}.ts`))
      await Promise.all(writes)
      const cacheDir = path.join(await makeRoot(), 'listings')
      const service = new FileSearchService(undefined, { cacheDir })
      services.push(service)

      const base = { root: URI.file(root), pattern: '', matchAll: true, maxResults: 3 }
      await service.search(base)
      await new Promise((r) => setTimeout(r, 50))
      expect(await listingNames(cacheDir)).toEqual([])

      // 用户打开 Ctrl+P（warmListing）才为击键兜底预建清单。
      await service.search({ ...base, warmListing: true })
      await vi.waitFor(async () => expect(await listingNames(cacheDir)).toHaveLength(1))
    })

    it('keeps a budget-truncated listing as a partial cache and reports truncation', async () => {
      const root = await makeRoot()
      await writeFile(root, 'd/f1.ts')
      await writeFile(root, 'd/f2.ts')
      const cacheDir = path.join(await makeRoot(), 'listings')
      const service = new FileSearchService(undefined, { cacheDir })
      services.push(service)
      // 被 kill 时末行只写了一半（d/f2）。
      const collect = mockBudgetKill(service, 'd/f1.ts\nd/f2')

      const complete = await service.search({ root: URI.file(root), pattern: 'f', maxResults: 5 })
      expect(asMatches(complete).results.map((r) => r.relativePath)).toEqual(['d/f1.ts'])
      expect(complete.limitHit).toBe(true)
      expect(complete.stopReason).toBe('maxResults')
      const built = await listingNames(cacheDir)
      expect(built).toHaveLength(1)
      expect(built[0]!.endsWith('.partial.list')).toBe(true)
      expect(await fs.readFile(path.join(cacheDir, built[0]!), 'utf8')).toBe('d/f1.ts\n')

      // 残缺清单在其 TTL 内复用，不重走。
      await service.search({ root: URI.file(root), pattern: 'f2', maxResults: 5 })
      expect(collect).toHaveBeenCalledTimes(1)
    })

    it('adopts a partial listing left on disk by an earlier session', async () => {
      const root = await makeRoot()
      await writeFile(root, 'alpha.ts')
      await writeFile(root, 'beta.ts')

      const cacheDir = path.join(await makeRoot(), 'listings')
      const first = new FileSearchService(undefined, { cacheDir })
      services.push(first)
      await first.search({ root: URI.file(root), pattern: 'alpha', maxResults: 5 })
      const [name] = await listingNames(cacheDir)
      // 伪造成上一会话超预算留下的残缺清单（只含 alpha）。
      const partialName = name!.replace(/\.list$/, '.partial.list')
      await fs.writeFile(path.join(cacheDir, partialName), `alpha.ts\n`)
      await fs.unlink(path.join(cacheDir, name!))

      const second = new FileSearchService(undefined, { cacheDir })
      services.push(second)
      const complete = await second.search({ root: URI.file(root), pattern: 'a', maxResults: 5 })
      expect(asMatches(complete).results.map((r) => r.relativePath)).toEqual(['alpha.ts'])
      expect(complete.limitHit).toBe(true)
    })
  })
})
