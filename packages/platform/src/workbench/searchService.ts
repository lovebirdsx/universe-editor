/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ITextSearchService — workspace-wide text search abstraction.
 *
 *  Implementations walk the active workspace folder, match each non-binary
 *  text file against a query, and return file/line/range matches. Cancellation
 *  uses native AbortSignal; progress is reported in-flight via onProgress so
 *  the caller can show a status-bar spinner without waiting for completion.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../di/instantiation.js'
import type { URI } from '../base/uri.js'

export interface ITextSearchQuery {
  readonly pattern: string
  readonly isRegex: boolean
  readonly matchCase: boolean
  readonly matchWholeWord: boolean
  /** Glob patterns; empty means "include everything". */
  readonly includes: readonly string[]
  /**
   * Glob patterns to exclude, on top of the configured files.exclude /
   * search.exclude globs the caller passes down. There are no other built-in
   * exclusions: whether .gitignore / .ignore files are honoured is governed
   * solely by the `search.useIgnoreFiles` setting.
   */
  readonly excludes: readonly string[]
  /** Total match cap across the whole search. Default 10000. */
  readonly maxResults?: number
  /** Optional provider-specific cap on files scanned. Unset means no file-count cap. */
  readonly maxFiles?: number
  /** Hard cap on matches recorded per file. Default 1000. */
  readonly maxMatchesPerFile?: number
}

export interface ITextSearchRange {
  /** 1-based column where the match starts. */
  readonly startColumn: number
  /** 1-based column one past the last matched character. */
  readonly endColumn: number
}

export interface ITextSearchMatch {
  /** 1-based line number. */
  readonly lineNumber: number
  /** Raw line text trimmed to a sensible preview length. */
  readonly preview: string
  readonly ranges: readonly ITextSearchRange[]
}

export interface IFileMatch {
  readonly resource: URI
  readonly matches: readonly ITextSearchMatch[]
}

export type SearchLimitHit = 'files' | 'matches' | 'matchesPerFile'

export interface ITextSearchProgress {
  readonly filesScanned: number
  readonly filesMatched: number
  readonly totalMatches: number
  readonly limitHit?: SearchLimitHit
}

export interface ITextSearchOptions {
  readonly onProgress?: (progress: ITextSearchProgress) => void
  /**
   * Incremental result batches delivered while the search is still running, so a
   * large result set fills in progressively instead of appearing all at once.
   * Each entry is a file's *full current* match set; consumers accumulate by
   * resource (a later batch for the same file replaces the earlier snapshot).
   * The promise's final result stays authoritative — treat it as the source of
   * truth on completion.
   */
  readonly onResults?: (batch: readonly IFileMatch[]) => void
  readonly signal?: AbortSignal
  /**
   * Apply the configured files.exclude / search.exclude globs (default true).
   * false searches everything those globs would have hidden, and also stops
   * honouring .gitignore / .ignore regardless of `search.useIgnoreFiles` — the
   * search view surfaces both halves under one "use exclude settings and ignore
   * files" toggle.
   */
  readonly useExcludeSettings?: boolean
}

export interface ITextSearchService {
  readonly _serviceBrand: undefined
  search(query: ITextSearchQuery, opts?: ITextSearchOptions): Promise<readonly IFileMatch[]>
}

export const ITextSearchService = createDecorator<ITextSearchService>('textSearchService')
