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
  IWorkspaceService,
  URI,
  type IFileMatch,
  type IFileService as IFileServiceType,
  type ITextSearchOptions,
  type ITextSearchProgress,
  type ITextSearchQuery,
  type ITextSearchService,
  type IWorkspaceService as IWorkspaceServiceType,
  type SearchLimitHit,
} from '@universe-editor/platform'
import { makeGlobMatcher } from './glob.js'
import { compileQuery, isBinary, scanText } from './scanText.js'

const DEFAULT_MAX_FILES = 1000
const DEFAULT_MAX_RESULTS = 10000
const DEFAULT_MAX_MATCHES_PER_FILE = 1000
const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024
const YIELD_EVERY = 32

const HARD_IGNORE_SEGMENTS = new Set([
  'node_modules',
  '.git',
  'dist',
  'out',
  '.turbo',
  '.next',
  '.cache',
])

function relPathOf(root: URI, child: URI): string {
  const rootP = root.path.endsWith('/') ? root.path : root.path + '/'
  const cp = child.path
  if (cp.startsWith(rootP)) return cp.slice(rootP.length)
  if (cp === root.path) return ''
  return cp
}

export class TextSearchService implements ITextSearchService {
  declare readonly _serviceBrand: undefined

  constructor(
    @IWorkspaceService private readonly _workspace: IWorkspaceServiceType,
    @IFileService private readonly _fileService: IFileServiceType,
  ) {}

  async search(
    query: ITextSearchQuery,
    opts: ITextSearchOptions = {},
  ): Promise<readonly IFileMatch[]> {
    const root = this._workspace.current?.folder ?? null
    if (!root) return []
    if (query.pattern.length === 0) return []

    let re: RegExp
    try {
      re = compileQuery(query)
    } catch {
      return []
    }

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

    const queue: URI[] = [root]
    while (queue.length > 0) {
      if (signal?.aborted) return results
      const dir = queue.shift()!
      let entries
      try {
        entries = await this._fileService.list(dir)
      } catch {
        continue
      }
      for (const entry of entries) {
        if (signal?.aborted) return results
        if (HARD_IGNORE_SEGMENTS.has(entry.name)) continue

        const child = URI.joinPath(dir, entry.name)
        const relPath = relPathOf(root, child)

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
            continue
          }
        } catch {
          // stat failure: try the read anyway; if it also fails we'll swallow.
        }

        let text: string
        try {
          text = await this._fileService.readFileText(child)
        } catch {
          filesScanned++
          continue
        }
        filesScanned++

        if (isBinary(text)) {
          // count as scanned, no matches
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
          if (signal?.aborted) return results
        }

        if (limitHit === 'files' || limitHit === 'matches') break
      }
      if (limitHit === 'files' || limitHit === 'matches') break
    }

    opts.onProgress?.(progressOf(filesScanned, filesMatched, totalMatches, limitHit))
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
