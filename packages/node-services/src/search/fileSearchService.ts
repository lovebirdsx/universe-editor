/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Workspace file-name search for quick access, backed by ripgrep. Electron-free
 *  so apps/editor main and a remote Node server share the same engine.
 *
 *  两级架构（对标 VSCode search 进程的内存清单缓存，但缓存放磁盘、不占主进程堆）：
 *    - 枚举：`rg --files` 把全量文件清单直接写进磁盘缓存文件（stdout 重定向到
 *      fd，主进程零拷贝、零解析）。stale-while-revalidate + TTL，跨重启按 mtime 复用。
 *    - 打分查询：并行 rg 在缓存文件上做子序列预过滤（basename 锚定 + 全路径两路，
 *      各截 PREFILTER_CAP 行），主进程只对合并后的少量候选行打分排序。此前逐击键
 *      的 JS 全树遍历会把主线程（输入路由所在线程）打满，造成 ~0.8s 的
 *      输入卡顿；现在重活全部在 rg 子进程里。
 *    - matchAll（预热清单）保持实时枚举语义：独立 `rg --files` 到 cap 即杀，不读
 *      缓存文件——renderer 侧 watcher 失效后的重载必须能看到新建文件。
 *--------------------------------------------------------------------------------------------*/

import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import {
  createNamedLogger,
  Disposable,
  getPathComparisonKey,
  IFileSearchService,
  normalizePlatform,
  URI,
  type CancellationToken,
  type IDisposable,
  type IFileSearchComplete,
  type IFileSearchMatch,
  type IFileSearchQuery,
  type ILogger,
  type ILoggerService as ILoggerServiceType,
  type UriComponents,
} from '@universe-editor/platform'
import {
  escapeForRegex,
  expandExcludeGlob,
  normalizeGlob,
  resolveSearchThreads,
  rgDiskPath,
} from './ripgrepUtil.js'

type RawUri = URI | UriComponents | string
type StopReason = NonNullable<IFileSearchComplete['stopReason']>

const DEFAULT_MAX_RESULTS = 512
const DEFAULT_MAX_DEPTH = 30
const DEFAULT_SEARCH_TIMEOUT_MS = 60_000
// 每路预过滤 rg 的候选行上限：两路合并后主进程最多打分 ~2 万行（毫秒级）。
// 上限内候选按清单流序截断，basename 锚定那一路保证高质量命中优先存活。
const PREFILTER_CAP = 10_000
// 清单缓存新鲜期：过期后旧清单仍即时可用（stale-while-revalidate），后台重建。
const LISTING_TTL_MS = 5 * 60_000
const LISTING_SWEEP_AGE_MS = 7 * 24 * 60 * 60_000
const SCORE_YIELD_EVERY = 4096
const STDERR_LIMIT = 100_000

function reviveUri(value: RawUri): URI {
  if (value instanceof URI) return value
  if (typeof value === 'string') return URI.parse(value)
  return URI.revive(value as UriComponents) as URI
}

function normalizeRel(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
}

function fuzzyMatchField(text: string, query: string): boolean {
  if (!query) return true
  const t = text.toLowerCase()
  const q = query.toLowerCase()
  let qi = 0
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) qi++
  }
  return qi === q.length
}

function scoreFuzzyMatch(text: string, query: string): number {
  if (!query) return 0
  const t = text.toLowerCase()
  const q = query.toLowerCase()
  if (t.startsWith(q)) return 1000 - t.length
  if (t.includes(q)) return 500 - t.length
  if (fuzzyMatchField(t, q)) return 50 - t.length
  return -1
}

function scoreFileMatch(basename: string, relativePath: string, pattern: string): number {
  const pieces = pattern
    .trim()
    .replace(/\\/g, '/')
    .split(/\s+/)
    .filter((piece) => piece.length > 0)
  if (pieces.length === 0) return -1

  let total = 0
  for (const piece of pieces) {
    const basenameScore = scoreFuzzyMatch(basename, piece)
    const pathScore = scoreFuzzyMatch(relativePath, piece)
    const score = Math.max(
      basenameScore >= 0 ? basenameScore + 2000 : -1,
      pathScore >= 0 ? pathScore : -1,
    )
    if (score < 0) return -1
    total += score
  }
  return total
}

function hasPathSeparator(value: string): boolean {
  return value.includes('/') || value.includes('\\')
}

async function statFile(candidate: string): Promise<boolean> {
  try {
    const stat = await fs.stat(candidate)
    return stat.isFile()
  } catch {
    return false
  }
}

// Plain code-unit comparison for the tie-break: localeCompare goes through ICU
// and at matchAll scale (100k entries) turns the final sort into seconds.
function compareMatches(a: IFileSearchMatch, b: IFileSearchMatch): number {
  if (b.score !== a.score) return b.score - a.score
  return a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0
}

// 子序列预过滤正则：把 piece 的每个字符按序放宽。withinSegment 时字符间只允许
// 非分隔符（即 basename 内的子序列，行尾锚定）；否则允许任意字符（全路径子序列，
// 打分侧 path-tier 的超集）。清单文件在 Windows 上是反斜杠分隔，两种都要兼容。
function subsequencePattern(piece: string, withinSegment: boolean): string {
  const joiner = withinSegment ? '[^/\\\\]*' : '.*'
  const parts: string[] = []
  for (const ch of piece) {
    parts.push(ch === '/' || ch === '\\' ? '[/\\\\]' : escapeForRegex(ch))
  }
  return withinSegment ? `${parts.join(joiner)}[^/\\\\]*$` : parts.join(joiner)
}

// 预过滤只用最长 piece（选择性最高），其余 piece 由主进程打分兜底核验。
function longestPiece(pattern: string): string {
  const pieces = pattern
    .trim()
    .replace(/\\/g, '/')
    .split(/\s+/)
    .filter((piece) => piece.length > 0)
  let longest = ''
  for (const piece of pieces) {
    if (piece.length > longest.length) longest = piece
  }
  return longest
}

interface ListingSpec {
  readonly rootFsPath: string
  readonly excludes: readonly string[]
  readonly ignore: readonly string[]
  readonly maxDepth: number
  readonly scanPaths: readonly string[]
  readonly rootFilesInScope: boolean
  readonly useIgnoreFiles: boolean
}

interface RgCollectExit {
  readonly code: number | null
  readonly error?: string
  readonly stderr: string
}

function fileListArgs(spec: ListingSpec): string[] {
  const args = ['--files', '--hidden', '--no-require-git']
  // See buildRgArgs: the file-name listing follows the same search.useIgnoreFiles
  // setting so Ctrl+P and text search agree on what is part of the workspace.
  if (!spec.useIgnoreFiles) {
    args.push('--no-ignore', '--no-ignore-global')
  }
  args.push(
    '--no-config',
    '--follow',
    '--max-depth',
    String(spec.maxDepth),
    '--threads',
    String(resolveSearchThreads(undefined)),
  )
  for (const exclude of spec.excludes.flatMap(expandExcludeGlob)) {
    args.push('-g', `!${exclude}`)
  }
  for (const raw of spec.ignore) {
    const name = normalizeGlob(raw)
    if (!name) continue
    args.push('-g', `!**/${name}`, '-g', `!**/${name}/**`)
  }
  if (spec.scanPaths.length > 0) args.push(...spec.scanPaths)
  return args
}

function listingKey(spec: ListingSpec): string {
  const canonical = JSON.stringify({
    root: getPathComparisonKey(spec.rootFsPath, normalizePlatform(process.platform)),
    excludes: [...spec.excludes].sort(),
    ignore: [...spec.ignore].sort(),
    maxDepth: spec.maxDepth,
    scanPaths: [...spec.scanPaths].sort(),
    rootFilesInScope: spec.rootFilesInScope,
    // Part of the key: the two settings produce different file sets, so sharing
    // one cached listing between them would serve the previous setting's result.
    useIgnoreFiles: spec.useIgnoreFiles,
  })
  return createHash('sha1').update(canonical).digest('hex').slice(0, 16)
}

interface ListingFile {
  readonly filePath: string
  readonly builtAt: number
}

interface ListingEntry {
  readonly key: string
  file?: ListingFile
  building?: Promise<ListingFile | null>
  diskProbed?: boolean
}

interface RgLinesResult {
  readonly lines: string[]
  readonly capped: boolean
  readonly stopReason: StopReason | null
}

export interface FileSearchServiceOptions {
  /** 覆盖清单缓存目录（测试注入临时目录用）。 */
  readonly cacheDir?: string
}

export class FileSearchService extends Disposable implements IFileSearchService {
  declare readonly _serviceBrand: undefined

  private readonly _logger: ILogger
  private readonly _cacheDir: string
  private readonly _listings = new Map<string, ListingEntry>()
  private readonly _procs = new Set<ChildProcess>()

  constructor(loggerService?: ILoggerServiceType, options?: FileSearchServiceOptions) {
    super()
    this._logger = createNamedLogger(loggerService, { id: 'fileSearch', name: 'File Search' })
    this._cacheDir = options?.cacheDir ?? path.join(os.tmpdir(), 'universe-editor-file-listings')
    void this._sweepStaleListings()
  }

  async search(query: IFileSearchQuery, token?: CancellationToken): Promise<IFileSearchComplete> {
    const startedAt = Date.now()
    const root = reviveUri(query.root as RawUri)
    // 本机 ripgrep 只搜 file: 目录；远端工作区由远端 search 服务接管，fail loud。
    if (root.scheme !== 'file') {
      throw new Error(`fileSearch: unsupported scheme: ${root.scheme}`)
    }
    const pattern = query.pattern.trim()
    const matchAll = query.matchAll === true
    const maxResults = Math.max(1, query.maxResults ?? DEFAULT_MAX_RESULTS)
    const timeoutMs = query.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS
    const deadlineAt = startedAt + timeoutMs
    const spec: ListingSpec = {
      rootFsPath: root.fsPath,
      excludes: query.excludes ?? [],
      ignore: query.ignore ?? [],
      maxDepth: query.maxDepth ?? DEFAULT_MAX_DEPTH,
      scanPaths: query.scanPaths ?? [],
      rootFilesInScope: query.rootFilesInScope === true,
      useIgnoreFiles: query.useIgnoreFiles === true,
    }

    let stopReason: StopReason | null = null
    let filesWalked = 0
    const scored: IFileSearchMatch[] = []
    let matchesFound = 0

    if (token?.isCancellationRequested) stopReason = 'canceled'
    else if (Date.now() >= deadlineAt) stopReason = 'timeout'
    if (stopReason !== null) {
      return this._complete(root, pattern, [], 0, {
        matchesFound,
        filesWalked,
        startedAt,
        stopReason,
      })
    }

    if (
      pattern.length > 0 &&
      query.includeExactPathMatches !== false &&
      hasPathSeparator(pattern)
    ) {
      const directPath = path.isAbsolute(pattern) ? pattern : path.join(root.fsPath, pattern)
      if (await statFile(directPath)) {
        const rel = normalizeRel(path.relative(root.fsPath, directPath))
        scored.push({
          resource: URI.file(directPath),
          fsPath: directPath,
          relativePath: rel,
          basename: path.basename(directPath),
          score: Number.MAX_SAFE_INTEGER,
        })
        matchesFound++
      }
    }

    if (matchAll) {
      const res = await this._runRgLines({
        args: fileListArgs(spec),
        cwd: spec.rootFsPath,
        cap: maxResults,
        token,
        deadlineAt,
        label: 'list',
      })
      let lines = res.lines
      let capped = res.capped
      stopReason = res.stopReason ?? (res.capped ? 'maxResults' : null)
      // 聚焦时根的直接文件在任何 scan path 之外，需要一次独立的浅层枚举补上。
      if (spec.rootFilesInScope && spec.scanPaths.length > 0 && stopReason === null) {
        const rootRes = await this._runRgLines({
          args: fileListArgs({ ...spec, scanPaths: [], maxDepth: 1 }),
          cwd: spec.rootFsPath,
          cap: Math.max(0, maxResults - lines.length),
          token,
          deadlineAt,
          label: 'rootFiles',
        })
        lines = [...lines, ...rootRes.lines]
        capped = capped || rootRes.capped
        stopReason = rootRes.stopReason ?? (rootRes.capped ? 'maxResults' : null)
      }
      filesWalked = lines.length
      for (const line of lines) {
        const rel = normalizeRel(line)
        const abs = path.join(spec.rootFsPath, rel)
        scored.push({
          resource: URI.file(abs),
          fsPath: abs,
          relativePath: rel,
          basename: rel.slice(rel.lastIndexOf('/') + 1),
          score: 0,
        })
        matchesFound++
      }
      // 清单被截断说明这是巨型工作区：renderer 之后的每次击键都会走打分兜底，
      // 提前把磁盘清单建好（后台，不阻塞本次调用）。
      if (capped) this._kickBackgroundBuild(spec)
    } else if (pattern.length > 0) {
      const listing = await this._ensureListingForQuery(spec, token, deadlineAt)
      if (listing === 'canceled' || listing === 'timeout') {
        stopReason = listing
      } else if (listing === null) {
        // 清单构建失败（rg 不可用等）：只剩 exact-path 探测结果，标记截断。
        stopReason = 'timeout'
        this._logger.error(`fileSearch listing unavailable root=${spec.rootFsPath}`)
      } else {
        const piece = longestPiece(pattern)
        const runFilter = (regex: string): Promise<RgLinesResult> =>
          this._runRgLines({
            args: ['-i', '--no-config', '-m', String(PREFILTER_CAP), '--', regex, listing.filePath],
            cap: PREFILTER_CAP,
            token,
            deadlineAt,
            label: 'filter',
          })
        const passes: Promise<RgLinesResult>[] = []
        if (!piece.includes('/')) passes.push(runFilter(subsequencePattern(piece, true)))
        passes.push(runFilter(subsequencePattern(piece, false)))
        const results = await Promise.all(passes)
        stopReason = results.find((r) => r.stopReason !== null)?.stopReason ?? null
        const prefilterCapped = results.some((r) => r.capped)

        const seenLines = new Set<string>()
        const candidates: string[] = []
        for (const res of results) {
          for (const line of res.lines) {
            const rel = normalizeRel(line)
            const key = rel.toLowerCase()
            if (seenLines.has(key)) continue
            seenLines.add(key)
            candidates.push(rel)
          }
        }
        filesWalked = candidates.length

        // 打分是纯 CPU 循环（候选 ≤ 2×PREFILTER_CAP），分块让出事件循环。
        // Once compacted, anything scoring below the floor is provably outside
        // the global top-K (ties stay in for the path tie-break).
        let scoreFloor = -Infinity
        const keepCount = maxResults + 1
        const compactThreshold = Math.max(keepCount * 2, 256)
        for (let i = 0; i < candidates.length; i++) {
          if ((i & (SCORE_YIELD_EVERY - 1)) === SCORE_YIELD_EVERY - 1) {
            await new Promise<void>((resolve) => setImmediate(resolve))
            if (token?.isCancellationRequested) {
              stopReason = 'canceled'
              break
            }
          }
          const rel = candidates[i]!
          const base = rel.slice(rel.lastIndexOf('/') + 1)
          const score = scoreFileMatch(base, rel, pattern)
          if (score < 0) continue
          matchesFound++
          if (score < scoreFloor) continue
          const abs = path.join(spec.rootFsPath, rel)
          scored.push({
            resource: URI.file(abs),
            fsPath: abs,
            relativePath: rel,
            basename: base,
            score,
          })
          if (scored.length >= compactThreshold) {
            scored.sort(compareMatches)
            scored.length = keepCount
            scoreFloor = scored[scored.length - 1]!.score
          }
        }
        if (prefilterCapped && stopReason === null) stopReason = 'maxResults'
      }
    }

    const seen = new Set<string>()
    const kept = scored.sort(compareMatches).filter((match) => {
      const key = getPathComparisonKey(match.fsPath, normalizePlatform(process.platform))
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    const limited = kept.slice(0, maxResults)
    // Duplicates removed by dedup are not truncation; everything else that was
    // matched but did not make the page is.
    const uniqueMatches = matchesFound - (scored.length - kept.length)
    return this._complete(root, pattern, limited, uniqueMatches, {
      matchesFound,
      filesWalked,
      startedAt,
      stopReason,
    })
  }

  override dispose(): void {
    for (const child of this._procs) {
      try {
        child.kill()
      } catch {
        // 已退出。
      }
    }
    this._procs.clear()
    super.dispose()
  }

  // ---------------------------------------------------------------- 清单缓存

  private _entryFor(spec: ListingSpec): ListingEntry {
    const key = listingKey(spec)
    let entry = this._listings.get(key)
    if (!entry) {
      entry = { key }
      this._listings.set(key, entry)
    }
    return entry
  }

  private _kickBackgroundBuild(spec: ListingSpec): void {
    const entry = this._entryFor(spec)
    void this._probeDisk(entry).then(() => {
      if (entry.building) return
      if (entry.file && Date.now() - entry.file.builtAt < LISTING_TTL_MS) return
      void this._build(entry, spec)
    })
  }

  /**
   * 拿到可用的清单文件：磁盘上有（含跨重启残留）就直接用，过期则先用旧的、
   * 后台重建；完全没有时同步等待构建（打分查询没有清单无从谈起——renderer
   * 侧的本地缓存池仍在即时出结果，这里的等待只体现为 busy 条）。
   */
  private async _ensureListingForQuery(
    spec: ListingSpec,
    token: CancellationToken | undefined,
    deadlineAt: number,
  ): Promise<ListingFile | null | 'canceled' | 'timeout'> {
    const entry = this._entryFor(spec)
    await this._probeDisk(entry)
    if (entry.file) {
      if (Date.now() - entry.file.builtAt >= LISTING_TTL_MS && !entry.building) {
        void this._build(entry, spec)
      }
      return entry.file
    }
    const building = entry.building ?? this._build(entry, spec)
    let sub: IDisposable | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await new Promise<ListingFile | null | 'canceled' | 'timeout'>((resolve) => {
        sub = token?.onCancellationRequested(() => resolve('canceled'))
        timer = setTimeout(() => resolve('timeout'), Math.max(0, deadlineAt - Date.now()))
        building.then(
          (file) => resolve(file),
          () => resolve(null),
        )
      })
    } finally {
      sub?.dispose()
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  private async _probeDisk(entry: ListingEntry): Promise<void> {
    if (entry.diskProbed) return
    entry.diskProbed = true
    try {
      const names = (await fs.readdir(this._cacheDir))
        .filter((n) => n.startsWith(`${entry.key}-`) && n.endsWith('.list'))
        .sort()
      const newest = names[names.length - 1]
      if (newest === undefined) return
      for (const old of names.slice(0, -1)) {
        void fs.unlink(path.join(this._cacheDir, old)).catch(() => undefined)
      }
      const filePath = path.join(this._cacheDir, newest)
      const stat = await fs.stat(filePath)
      if (entry.file === undefined) {
        entry.file = { filePath, builtAt: stat.mtimeMs }
      }
    } catch {
      // 缓存目录尚不存在。
    }
  }

  private _build(entry: ListingEntry, spec: ListingSpec): Promise<ListingFile | null> {
    if (entry.building) return entry.building
    const startedAt = Date.now()
    const promise = (async (): Promise<ListingFile | null> => {
      try {
        await fs.mkdir(this._cacheDir, { recursive: true })
        const stamp = Date.now()
        const tmpPath = path.join(this._cacheDir, `${entry.key}-${stamp}.building`)
        const finalPath = path.join(this._cacheDir, `${entry.key}-${stamp}.list`)
        const fh = await fs.open(tmpPath, 'w')
        const exit = await this._collectToFile(fh, fileListArgs(spec), spec.rootFsPath)
        // 聚焦时根的直接文件在任何 scan path 之外：主清单写完后追加一次浅层枚举。
        let rootExit: RgCollectExit | undefined
        if (
          exit.error === undefined &&
          exit.code !== null &&
          spec.rootFilesInScope &&
          spec.scanPaths.length > 0
        ) {
          rootExit = await this._collectToFile(
            fh,
            fileListArgs({ ...spec, scanPaths: [], maxDepth: 1 }),
            spec.rootFsPath,
          )
        }
        await fh.close()
        // code === null 意味着 spawn 失败或被 kill（dispose/部分退出）——清单不完整，
        // 绝不能当可用缓存落盘。rg 对个别不可读目录会以 code 2 退出但清单仍有效。
        if (exit.error !== undefined || exit.code === null) {
          await fs.unlink(tmpPath).catch(() => undefined)
          if (exit.error !== undefined) {
            this._logger.error(`fileSearch listing build failed: ${exit.error}`)
          }
          return null
        }
        // 根文件补扫失败只丢根直接文件（数量极少），清单主体完整，仍可落盘。
        if (rootExit !== undefined && (rootExit.error !== undefined || rootExit.code === null)) {
          this._logger.warn(
            `fileSearch root-files listing partial: ${rootExit.error ?? 'killed before exit'}`,
          )
        }
        await fs.rename(tmpPath, finalPath)
        const prev = entry.file
        entry.file = { filePath: finalPath, builtAt: Date.now() }
        if (prev) void fs.unlink(prev.filePath).catch(() => undefined)
        const stat = await fs.stat(finalPath).catch(() => null)
        this._logger.info(
          `fileSearch listing built root=${spec.rootFsPath} bytes=${stat?.size ?? -1} ` +
            `exit=${exit.code} ms=${Date.now() - startedAt}`,
        )
        if (exit.code !== 0 && exit.code !== 1 && exit.stderr.trim().length > 0) {
          this._logger.warn(
            `fileSearch listing build partial (exit=${exit.code}): ${exit.stderr.split('\n')[0]}`,
          )
        }
        return entry.file
      } catch (err) {
        this._logger.error(`fileSearch listing build error: ${(err as Error).message}`)
        return null
      } finally {
        delete entry.building
      }
    })()
    entry.building = promise
    return promise
  }

  private _collectToFile(
    fh: FileHandle,
    args: readonly string[],
    cwd: string,
  ): Promise<RgCollectExit> {
    return new Promise((resolve) => {
      let child: ChildProcess
      let stderr = ''
      try {
        child = spawn(rgDiskPath, args as string[], {
          cwd,
          stdio: ['ignore', fh.fd, 'pipe'],
          windowsHide: true,
        })
      } catch (err) {
        resolve({ code: null, error: (err as Error).message, stderr })
        return
      }
      this._procs.add(child)
      child.stderr?.on('data', (data: Buffer) => {
        if (stderr.length < STDERR_LIMIT) stderr += data.toString()
      })
      child.on('error', (err) => {
        this._procs.delete(child)
        resolve({ code: null, error: err.message, stderr })
      })
      child.on('exit', (code) => {
        this._procs.delete(child)
        resolve({ code, stderr })
      })
    })
  }

  private async _sweepStaleListings(): Promise<void> {
    try {
      const names = await fs.readdir(this._cacheDir)
      const now = Date.now()
      await Promise.all(
        names
          .filter((n) => n.endsWith('.list') || n.endsWith('.building'))
          .map(async (n) => {
            const filePath = path.join(this._cacheDir, n)
            const stat = await fs.stat(filePath).catch(() => null)
            if (stat && now - stat.mtimeMs > LISTING_SWEEP_AGE_MS) {
              await fs.unlink(filePath).catch(() => undefined)
            }
          }),
      )
    } catch {
      // 缓存目录尚不存在。
    }
  }

  // ------------------------------------------------------------- rg 行收集

  private _runRgLines(opts: {
    readonly args: readonly string[]
    readonly cwd?: string
    readonly cap: number
    readonly token: CancellationToken | undefined
    readonly deadlineAt: number
    readonly label: string
  }): Promise<RgLinesResult> {
    const { args, cwd, cap, token, deadlineAt, label } = opts
    if (token?.isCancellationRequested) {
      return Promise.resolve({ lines: [], capped: false, stopReason: 'canceled' })
    }
    const timeLeft = deadlineAt - Date.now()
    if (timeLeft <= 0) {
      return Promise.resolve({ lines: [], capped: false, stopReason: 'timeout' })
    }

    return new Promise<RgLinesResult>((resolve) => {
      let child: ChildProcess
      try {
        child = spawn(rgDiskPath, args as string[], {
          ...(cwd !== undefined ? { cwd } : {}),
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        })
      } catch (err) {
        this._logger.error(`fileSearch rg(${label}) spawn error: ${(err as Error).message}`)
        resolve({ lines: [], capped: false, stopReason: null })
        return
      }
      this._procs.add(child)
      const decoder = new StringDecoder('utf8')
      const lines: string[] = []
      let remainder = ''
      let stderr = ''
      let capped = false
      let stopReason: StopReason | null = null
      let settled = false

      const append = (chunk: string): void => {
        if (stopReason !== null || capped) return
        const data = remainder + chunk
        const parts = data.split(/\r?\n/)
        remainder = parts.pop() ?? ''
        for (const part of parts) {
          if (part.length === 0) continue
          lines.push(part)
          if (lines.length >= cap) {
            capped = true
            remainder = ''
            child.kill()
            return
          }
        }
      }

      const tokenSub = token?.onCancellationRequested(() => {
        stopReason = 'canceled'
        child.kill()
      })
      const timer = setTimeout(() => {
        if (settled) return
        stopReason = 'timeout'
        child.kill()
      }, timeLeft)

      const finish = (): void => {
        if (settled) return
        settled = true
        this._procs.delete(child)
        tokenSub?.dispose()
        clearTimeout(timer)
        if (stopReason === null && !capped) {
          append(decoder.end())
          if (remainder.length > 0 && lines.length < cap) {
            lines.push(remainder)
            if (lines.length >= cap) capped = true
          }
        }
        resolve({ lines, capped, stopReason })
      }

      child.stdout?.on('data', (data: Buffer) => {
        if (token?.isCancellationRequested) return
        if (Date.now() >= deadlineAt) {
          stopReason = 'timeout'
          child.kill()
          return
        }
        append(decoder.write(data))
      })
      child.stderr?.on('data', (data: Buffer) => {
        if (stderr.length < STDERR_LIMIT) stderr += data.toString()
      })
      child.on('error', (err) => {
        this._logger.warn(`fileSearch rg(${label}) error: ${err.message}`)
        finish()
      })
      child.on('exit', (code) => {
        if (
          stopReason === null &&
          !capped &&
          code !== 0 &&
          code !== 1 &&
          stderr.trim().length > 0
        ) {
          this._logger.warn(`fileSearch rg(${label}) exit=${code}: ${stderr.split('\n')[0]}`)
        }
        finish()
      })
    })
  }

  private _complete(
    root: URI,
    pattern: string,
    limited: IFileSearchMatch[],
    uniqueMatches: number,
    stats: {
      matchesFound: number
      filesWalked: number
      startedAt: number
      stopReason: StopReason | null
    },
  ): IFileSearchComplete {
    const { matchesFound, filesWalked, startedAt, stopReason } = stats
    const complete: IFileSearchComplete = {
      results: limited,
      limitHit: stopReason !== null || uniqueMatches > limited.length,
      filesWalked,
      directoriesWalked: 0,
      durationMs: Date.now() - startedAt,
      ...(stopReason !== null ? { stopReason } : {}),
    }
    const summary =
      `fileSearch root=${root.fsPath} pattern=${pattern} results=${limited.length} ` +
      `limitHit=${complete.limitHit} matches=${matchesFound} candidates=${filesWalked} ` +
      `ms=${complete.durationMs}` +
      (stopReason !== null ? ` stop=${stopReason}` : '')
    if (stopReason === 'timeout') {
      this._logger.warn(summary)
    } else {
      this._logger.debug(summary)
    }
    return complete
  }
}
