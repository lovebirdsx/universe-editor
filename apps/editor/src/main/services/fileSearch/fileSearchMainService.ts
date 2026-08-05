/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Main-process workspace file-name search for quick access.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  createNamedLogger,
  getPathComparisonKey,
  IFileSearchService,
  ILoggerService,
  makeExcludeMatcher,
  normalizePlatform,
  URI,
  type CancellationToken,
  type IFileSearchComplete,
  type IFileSearchMatch,
  type IFileSearchQuery,
  type ILogger,
  type ILoggerService as ILoggerServiceType,
  type UriComponents,
} from '@universe-editor/platform'

type RawUri = URI | UriComponents | string
type StopReason = NonNullable<IFileSearchComplete['stopReason']>

const DEFAULT_MAX_RESULTS = 512
const DEFAULT_MAX_DEPTH = 30
// A walk must never run unbounded: on a pathological workspace (millions of
// files) it previously accumulated matches until the main process hit the V8
// heap limit and aborted. The timeout returns whatever was found so far.
const DEFAULT_WALK_TIMEOUT_MS = 60_000
// Directory reads are I/O-bound and were previously awaited one directory at a
// time; a small concurrency pool cuts the full-workspace walk ~5x (measured
// 142ms → 26ms on a 5k-file monorepo) without flooding the disk queue.
const SCAN_CONCURRENCY = 16

function reviveUri(value: RawUri): URI {
  if (value instanceof URI) return value
  if (typeof value === 'string') return URI.parse(value)
  return URI.revive(value as UriComponents) as URI
}

function normalizeRel(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\/+/, '')
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

export class FileSearchMainService implements IFileSearchService {
  declare readonly _serviceBrand: undefined

  private readonly _logger: ILogger

  constructor(@ILoggerService loggerService?: ILoggerServiceType) {
    this._logger = createNamedLogger(loggerService, { id: 'fileSearch', name: 'File Search' })
  }

  async search(query: IFileSearchQuery, token?: CancellationToken): Promise<IFileSearchComplete> {
    const startedAt = Date.now()
    const root = reviveUri(query.root as RawUri)
    const pattern = query.pattern.trim()
    const matchAll = query.matchAll === true
    const maxResults = Math.max(1, query.maxResults ?? DEFAULT_MAX_RESULTS)
    const maxDepth = query.maxDepth ?? DEFAULT_MAX_DEPTH
    const timeoutMs = query.timeoutMs ?? DEFAULT_WALK_TIMEOUT_MS
    const ignore = new Set(query.ignore ?? [])
    const excludeObject = Object.fromEntries((query.excludes ?? []).map((glob) => [glob, true]))
    const excludeMatcher = makeExcludeMatcher(excludeObject)
    const scored: IFileSearchMatch[] = []
    let matchesFound = 0
    let filesWalked = 0
    let directoriesWalked = 0
    let stopReason: StopReason | null = null
    // Once the accumulator is compacted, anything scoring below the floor is
    // provably outside the global top-K (ties stay in for the path tie-break).
    let scoreFloor = -Infinity
    // +1 spare seat: an exact-path match and its walked twin dedupe to one
    // entry, which would otherwise leave the final page one result short.
    const keepCount = maxResults + 1
    const compactThreshold = Math.max(keepCount * 2, 256)

    const shouldStop = (): boolean => {
      if (stopReason !== null) return true
      if (token?.isCancellationRequested) {
        stopReason = 'canceled'
        return true
      }
      if (Date.now() - startedAt >= timeoutMs) {
        stopReason = 'timeout'
        return true
      }
      return false
    }

    const pushMatch = (absPath: string, relPath: string, basename: string, score: number): void => {
      matchesFound++
      if (score < scoreFloor) return
      scored.push({
        resource: URI.file(absPath),
        fsPath: absPath,
        relativePath: relPath,
        basename,
        score,
      })
      // Scored walks traverse the whole tree for a globally best top-K, so the
      // accumulator — not the walk — must be bounded (the unbounded-growth OOM).
      if (!matchAll && scored.length >= compactThreshold) {
        scored.sort(compareMatches)
        scored.length = keepCount
        const worstKept = scored[scored.length - 1]
        if (worstKept) scoreFloor = worstKept.score
      }
    }

    if (shouldStop()) {
      return this._complete(root, pattern, [], 0, {
        matchesFound,
        filesWalked,
        directoriesWalked,
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
        pushMatch(directPath, rel, path.basename(directPath), Number.MAX_SAFE_INTEGER)
      }
    }

    if (matchAll || pattern.length > 0) {
      const scan = async (dir: string, depth: number): Promise<void> => {
        if (depth > maxDepth || shouldStop()) return
        directoriesWalked++
        const dirents = await fs
          .readdir(dir, { withFileTypes: true, encoding: 'utf8' })
          .catch(() => null)
        if (!dirents) return

        // Dirent carries lstat semantics: a symlink reports neither file nor
        // directory. Follow them (concurrently) to surface the target's type so
        // links join the walk like any other entry.
        const kinds = await Promise.all(
          dirents.map(async (d) => {
            let isDirectory = d.isDirectory()
            let isFile = d.isFile()
            if (d.isSymbolicLink()) {
              try {
                const s = await fs.stat(path.join(dir, d.name))
                isDirectory = s.isDirectory()
                isFile = s.isFile()
              } catch {
                return { d, isDirectory: false, isFile: false }
              }
            }
            return { d, isDirectory, isFile }
          }),
        )
        if (shouldStop()) return

        const subdirs: string[] = []
        for (const { d, isDirectory, isFile } of kinds) {
          const absPath = path.join(dir, d.name)
          if (isDirectory) {
            const relPath = normalizeRel(path.relative(root.fsPath, absPath))
            if (ignore.has(d.name) || excludeMatcher?.(relPath)) continue
            subdirs.push(absPath)
            continue
          }
          if (!isFile) continue
          const relPath = normalizeRel(path.relative(root.fsPath, absPath))
          filesWalked++
          if (excludeMatcher?.(relPath)) continue
          const score = matchAll ? 0 : scoreFileMatch(d.name, relPath, pattern)
          if (score >= 0) {
            pushMatch(absPath, relPath, d.name, score)
            // matchAll has no scoring, so results are interchangeable and the
            // walk itself can stop at the cap (callers sort what they get).
            if (matchAll && scored.length >= maxResults) {
              stopReason = 'maxResults'
              break
            }
          }
        }
        if (stopReason !== null) return

        for (let i = 0; i < subdirs.length; i += SCAN_CONCURRENCY) {
          if (shouldStop()) return
          await Promise.all(subdirs.slice(i, i + SCAN_CONCURRENCY).map((s) => scan(s, depth + 1)))
        }
      }

      await scan(root.fsPath, 0)
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
    // matched but did not make the page (compacted away or sliced off) is.
    const uniqueMatches = matchesFound - (scored.length - kept.length)
    return this._complete(root, pattern, limited, uniqueMatches, {
      matchesFound,
      filesWalked,
      directoriesWalked,
      startedAt,
      stopReason,
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
      directoriesWalked: number
      startedAt: number
      stopReason: StopReason | null
    },
  ): IFileSearchComplete {
    const { matchesFound, filesWalked, directoriesWalked, startedAt, stopReason } = stats
    const complete: IFileSearchComplete = {
      results: limited,
      limitHit: stopReason !== null || uniqueMatches > limited.length,
      filesWalked,
      directoriesWalked,
      durationMs: Date.now() - startedAt,
      ...(stopReason !== null ? { stopReason } : {}),
    }
    const summary =
      `fileSearch root=${root.fsPath} pattern=${pattern} results=${limited.length} ` +
      `limitHit=${complete.limitHit} matches=${matchesFound} files=${filesWalked} ` +
      `dirs=${directoriesWalked} ms=${complete.durationMs}` +
      (stopReason !== null ? ` stop=${stopReason}` : '')
    if (stopReason === 'timeout') {
      this._logger.warn(summary)
    } else {
      this._logger.debug(summary)
    }
    return complete
  }
}
