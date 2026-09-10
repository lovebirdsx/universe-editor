/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Workspace file-name search abstraction used by quick access surfaces.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../di/instantiation.js'
import type { CancellationToken } from '../base/cancellation.js'
import type { URI } from '../base/uri.js'

export interface IFileSearchQuery {
  readonly root: URI
  readonly pattern: string
  readonly matchAll?: boolean
  readonly excludes?: readonly string[]
  readonly ignore?: readonly string[]
  readonly maxResults?: number
  readonly maxDepth?: number
  readonly includeExactPathMatches?: boolean
  /** Wall-clock budget for the walk; partial results are returned on expiry. */
  readonly timeoutMs?: number
  /**
   * ripgrep `--iglob` (case-insensitive) prefilter. Name-only alternates (e.g.
   * `tsconfig*.json`) let a caller enumerate an entire tree for a handful of
   * files without paying for the full listing. Case-insensitivity makes the
   * prefilter broader than the caller's intent, so the caller must still
   * filter the returned paths precisely.
   */
  readonly glob?: readonly string[]
  /**
   * `matchAll` only: drop the listing entirely when the walk did not finish
   * (`limitHit: true` — `maxResults` cap, timeout or cancellation) instead of
   * returning the partial subset. Callers that cannot use an arbitrary subset —
   * a fuzzy filter would silently "not find" files outside it — take this to
   * keep a hundred-thousand-entry payload off the IPC wire.
   *
   * Note the implication runs one way only: dropping guarantees an empty
   * `relPaths`, but `limitHit: true` without this flag still returns whatever
   * the walk managed to enumerate.
   */
  readonly omitTruncatedListing?: boolean
  /**
   * Workspace-relative paths to enumerate instead of the whole root (ripgrep
   * positional arguments — may name directories *or single files*; a focus
   * entry may be one file). Results resolve against `root`. **Absent** = not
   * focused: enumerate the whole root. **Defined but empty** = focused with
   * nothing to enumerate beyond what `rootFilesInScope` covers — the two are
   * distinct states and the cache key keeps them apart.
   */
  readonly scanPaths?: readonly string[]
  /**
   * Also cover files directly inside `root` (depth 1) when `scanPaths` narrows
   * the walk — the root's own files live outside every scan path.
   */
  readonly rootFilesInScope?: boolean
  /**
   * Honour .gitignore / .ignore files (`search.useIgnoreFiles`). Absent = false,
   * matching the behaviour from before the setting existed. Part of the disk
   * listing cache key, so flipping it never serves a stale listing.
   */
  readonly useIgnoreFiles?: boolean
}

export interface IFileSearchMatch {
  readonly resource: URI
  readonly fsPath: string
  readonly relativePath: string
  readonly basename: string
  readonly score: number
}

export interface IFileSearchCompleteBase {
  readonly limitHit: boolean
  readonly filesWalked: number
  readonly directoriesWalked: number
  readonly durationMs: number
  /** Why the walk ended early, when it did not run to completion. */
  readonly stopReason?: 'maxResults' | 'timeout' | 'canceled'
}

/** Scored name search (`matchAll` absent). */
export interface IFileSearchMatches extends IFileSearchCompleteBase {
  readonly results: readonly IFileSearchMatch[]
}

/**
 * Whole-workspace listing (`matchAll: true`). Only workspace-relative paths
 * (`/`-separated) cross the wire: `basename` falls out of the last segment and
 * the absolute URI from joining `root`, so shipping them per entry would
 * duplicate the same path three times over — the payload is what makes a
 * hundred-thousand-file workspace block the renderer's main thread.
 */
export interface IFileSearchListing extends IFileSearchCompleteBase {
  readonly relPaths: readonly string[]
}

export type IFileSearchComplete = IFileSearchMatches | IFileSearchListing

export interface IFileSearchService {
  readonly _serviceBrand: undefined
  search(query: IFileSearchQuery, token?: CancellationToken): Promise<IFileSearchComplete>
}

export const IFileSearchService = createDecorator<IFileSearchService>('fileSearchService')
