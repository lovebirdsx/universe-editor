/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  TextSearchService — renderer-side workspace text search.
 *
 *  Walks the active workspace folder breadth-first, reads each candidate file
 *  via IFileService.readFileText, and scans the text against the compiled
 *  query. Honours AbortSignal, reports progress while running, and stops at
 *  the configured caps (maxFiles / maxResults / maxMatchesPerFile).
 *--------------------------------------------------------------------------------------------*/

import {
  IFileService,
  ILoggerService,
  ITextSearchService,
  IWorkspaceService,
  InstantiationType,
  URI,
  createNamedLogger,
  makeGlobMatcher,
  registerSingleton,
  type IFileMatch,
  type IFileService as IFileServiceType,
  type ILogger,
  type ILoggerService as ILoggerServiceType,
  type ITextSearchOptions,
  type ITextSearchProgress,
  type ITextSearchQuery,
  type IWorkspaceService as IWorkspaceServiceType,
  type SearchLimitHit,
} from '@universe-editor/platform'
import { compileQuery, isBinary, scanText } from './scanText.js'
import { IExcludeService } from '../exclude/ExcludeService.js'

const DEFAULT_MAX_FILES = 1000
const DEFAULT_MAX_RESULTS = 10000
const DEFAULT_MAX_MATCHES_PER_FILE = 1000
const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024
const YIELD_EVERY = 32

function relPathOf(root: URI, child: URI): string {
  const rootP = root.path.endsWith('/') ? root.path : root.path + '/'
  const cp = child.path
  if (cp.startsWith(rootP)) return cp.slice(rootP.length)
  if (cp === root.path) return ''
  return cp
}

export class TextSearchService implements ITextSearchService {
  declare readonly _serviceBrand: undefined

  private readonly _logger: ILogger

  constructor(
    @IWorkspaceService private readonly _workspace: IWorkspaceServiceType,
    @IFileService private readonly _fileService: IFileServiceType,
    @IExcludeService private readonly _exclude: IExcludeService,
    @ILoggerService loggerService: ILoggerServiceType,
  ) {
    this._logger = createNamedLogger(loggerService, { id: 'search', name: 'Search' })
  }

  async search(
    query: ITextSearchQuery,
    opts: ITextSearchOptions = {},
  ): Promise<readonly IFileMatch[]> {
    const root = this._workspace.current?.folder ?? null
    if (!root) {
      this._logger.debug('search skipped noWorkspace')
      return []
    }
    if (query.pattern.length === 0) {
      this._logger.debug('search skipped emptyPattern')
      return []
    }

    let re: RegExp
    try {
      re = compileQuery(query)
    } catch {
      this._logger.warn('search skipped invalidQuery')
      return []
    }
    const startedAt = Date.now()
    this._logger.info(
      `search start root=${root.toString()} includes=${query.includes.length} excludes=${query.excludes.length}`,
    )

    const maxFiles = query.maxFiles ?? DEFAULT_MAX_FILES
    const maxResults = query.maxResults ?? DEFAULT_MAX_RESULTS
    const maxMatchesPerFile = query.maxMatchesPerFile ?? DEFAULT_MAX_MATCHES_PER_FILE
    const includeMatcher = makeGlobMatcher(query.includes)
    const excludeMatcher = makeGlobMatcher(query.excludes)
    const signal = opts.signal

    const results: IFileMatch[] = []
    let filesScanned = 0
    let filesMatched = 0
    let totalMatches = 0
    let limitHit: SearchLimitHit | undefined
    let yieldCounter = 0
    let listFailures = 0
    let statFailures = 0
    let readFailures = 0
    let skippedLarge = 0
    let skippedBinary = 0

    const queue: URI[] = [root]
    while (queue.length > 0) {
      if (signal?.aborted) {
        this._logger.info(`search aborted files=${filesScanned} matches=${totalMatches}`)
        return results
      }
      const dir = queue.shift()!
      let entries
      try {
        entries = await this._fileService.list(dir)
      } catch {
        listFailures++
        continue
      }
      for (const entry of entries) {
        if (signal?.aborted) {
          this._logger.info(`search aborted files=${filesScanned} matches=${totalMatches}`)
          return results
        }

        const child = URI.joinPath(dir, entry.name)
        const relPath = relPathOf(root, child)

        // Configured excludes (files.exclude ∪ search.exclude) apply to both
        // directories (prune the subtree) and files.
        if (this._exclude.isExcluded(relPath, 'search')) continue

        if (excludeMatcher && excludeMatcher(relPath)) continue

        if (entry.isDirectory) {
          queue.push(child)
          continue
        }
        if (!entry.isFile) continue
        if (includeMatcher && !includeMatcher(relPath)) {
          continue
        }

        if (filesScanned >= maxFiles) {
          limitHit = 'files'
          break
        }

        try {
          const stat = await this._fileService.stat(child)
          if (stat.size > MAX_FILE_SIZE_BYTES) {
            filesScanned++
            skippedLarge++
            continue
          }
        } catch {
          // stat failure: try the read anyway; if it also fails we'll swallow.
          statFailures++
        }

        let text: string
        try {
          text = await this._fileService.readFileText(child)
        } catch {
          filesScanned++
          readFailures++
          continue
        }
        filesScanned++

        if (isBinary(text)) {
          // count as scanned, no matches
          skippedBinary++
        } else {
          const remaining = maxResults - totalMatches
          const cap = Math.min(maxMatchesPerFile, Math.max(0, remaining))
          if (cap > 0) {
            const { matches, truncated } = scanText(text, re, cap)
            if (matches.length > 0) {
              results.push({ resource: child.toJSON(), matches })
              filesMatched++
              let added = 0
              for (const m of matches) added += m.ranges.length
              totalMatches += added
              if (truncated && totalMatches < maxResults) {
                limitHit = 'matchesPerFile'
              }
              if (totalMatches >= maxResults) {
                limitHit = 'matches'
              }
            }
          } else {
            limitHit = 'matches'
          }
        }

        yieldCounter++
        if (yieldCounter % YIELD_EVERY === 0) {
          opts.onProgress?.(progressOf(filesScanned, filesMatched, totalMatches, limitHit))
          await Promise.resolve()
          if (signal?.aborted) {
            this._logger.info(`search aborted files=${filesScanned} matches=${totalMatches}`)
            return results
          }
        }

        if (limitHit === 'files' || limitHit === 'matches') break
      }
      if (limitHit === 'files' || limitHit === 'matches') break
    }

    opts.onProgress?.(progressOf(filesScanned, filesMatched, totalMatches, limitHit))
    const durationMs = Date.now() - startedAt
    this._logger.info(
      `search finished files=${filesScanned} matched=${filesMatched} matches=${totalMatches} ` +
        `limit=${limitHit ?? 'none'} ms=${durationMs} listFailures=${listFailures} ` +
        `statFailures=${statFailures} readFailures=${readFailures} ` +
        `skippedLarge=${skippedLarge} skippedBinary=${skippedBinary}`,
    )
    return results
  }
}

function progressOf(
  filesScanned: number,
  filesMatched: number,
  totalMatches: number,
  limitHit: SearchLimitHit | undefined,
): ITextSearchProgress {
  return limitHit !== undefined
    ? { filesScanned, filesMatched, totalMatches, limitHit }
    : { filesScanned, filesMatched, totalMatches }
}

registerSingleton(ITextSearchService, TextSearchService, InstantiationType.Delayed)
