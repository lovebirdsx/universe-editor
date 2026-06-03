/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Main-process workspace file-name search for quick access.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  createNamedLogger,
  IFileSearchService,
  ILoggerService,
  makeExcludeMatcher,
  URI,
  type IFileSearchComplete,
  type IFileSearchMatch,
  type IFileSearchQuery,
  type ILogger,
  type ILoggerService as ILoggerServiceType,
  type UriComponents,
} from '@universe-editor/platform'

type RawUri = URI | UriComponents | string

const DEFAULT_MAX_RESULTS = 512
const DEFAULT_MAX_DEPTH = 30

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

export class FileSearchMainService implements IFileSearchService {
  declare readonly _serviceBrand: undefined

  private readonly _logger: ILogger

  constructor(@ILoggerService loggerService?: ILoggerServiceType) {
    this._logger = createNamedLogger(loggerService, { id: 'fileSearch', name: 'File Search' })
  }

  async search(query: IFileSearchQuery): Promise<IFileSearchComplete> {
    const startedAt = Date.now()
    const root = reviveUri(query.root as RawUri)
    const pattern = query.pattern.trim()
    const matchAll = query.matchAll === true
    const maxResults = Math.max(1, query.maxResults ?? DEFAULT_MAX_RESULTS)
    const maxDepth = query.maxDepth ?? DEFAULT_MAX_DEPTH
    const ignore = new Set(query.ignore ?? [])
    const excludeObject = Object.fromEntries((query.excludes ?? []).map((glob) => [glob, true]))
    const excludeMatcher = makeExcludeMatcher(excludeObject)
    const scored: IFileSearchMatch[] = []
    let filesWalked = 0
    let directoriesWalked = 0

    const pushMatch = (absPath: string, relPath: string, basename: string, score: number): void => {
      scored.push({
        resource: URI.file(absPath).toJSON(),
        fsPath: absPath,
        relativePath: relPath,
        basename,
        score,
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
        if (depth > maxDepth) return
        directoriesWalked++
        const dirents = await fs
          .readdir(dir, { withFileTypes: true, encoding: 'utf8' })
          .catch(() => null)
        if (!dirents) return

        for (const d of dirents) {
          const absPath = path.join(dir, d.name)
          const relPath = normalizeRel(path.relative(root.fsPath, absPath))

          if (d.isDirectory()) {
            if (ignore.has(d.name) || excludeMatcher?.(relPath)) continue
            await scan(absPath, depth + 1)
            continue
          }

          if (!d.isFile()) continue
          filesWalked++
          if (excludeMatcher?.(relPath)) continue
          const score = matchAll ? 0 : scoreFileMatch(d.name, relPath, pattern)
          if (score >= 0) pushMatch(absPath, relPath, d.name, score)
        }
      }

      await scan(root.fsPath, 0)
    }

    const seen = new Set<string>()
    const results = scored
      .sort((a, b) => b.score - a.score || a.relativePath.localeCompare(b.relativePath))
      .filter((match) => {
        const key = process.platform === 'win32' ? match.fsPath.toLowerCase() : match.fsPath
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
    const limited = results.slice(0, maxResults)
    const complete = {
      results: limited,
      limitHit: results.length > limited.length,
      filesWalked,
      directoriesWalked,
      durationMs: Date.now() - startedAt,
    }
    this._logger.debug(
      `fileSearch root=${root.fsPath} pattern=${pattern} results=${limited.length} ` +
        `limitHit=${complete.limitHit} files=${filesWalked} dirs=${directoriesWalked} ms=${complete.durationMs}`,
    )
    return complete
  }
}
