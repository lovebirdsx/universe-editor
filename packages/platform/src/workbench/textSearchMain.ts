/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Wire contract for main-process text search sessions.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../di/instantiation.js'
import type { Event } from '../base/event.js'
import type { IFileMatch, ITextSearchProgress, ITextSearchQuery } from './searchService.js'
import type { UriComponents } from '../base/uri.js'

export interface ITextSearchMainQuery extends ITextSearchQuery {
  readonly sessionId: string
  readonly root: UriComponents
  readonly configurationExcludes: readonly string[]
  readonly maxFileSizeBytes?: number
  /** Ripgrep `--threads`; 0/absent = automatic (CPU cores − 2). */
  readonly threads?: number
  /**
   * Workspace-relative directories to search instead of the whole root
   * (ripgrep positional arguments). Results resolve against `root`. Absent or
   * empty = search the whole root.
   */
  readonly scanPaths?: readonly string[]
  /**
   * Also search files directly inside `root` (depth 1) when `scanPaths` narrows
   * the walk — the root's own files live outside every scan path.
   */
  readonly rootFilesInScope?: boolean
  /** Ripgrep `--max-depth`; only meaningful for shallow passes. */
  readonly maxDepth?: number
}

export interface ITextSearchMainProgressEvent {
  readonly sessionId: string
  readonly progress: ITextSearchProgress
}

export interface ITextSearchMainResultsEvent {
  readonly sessionId: string
  /** File match snapshots that changed since the last batch (full per-file). */
  readonly results: readonly IFileMatch[]
}

export interface ITextSearchMainComplete {
  readonly results: readonly IFileMatch[]
  readonly progress: ITextSearchProgress
  readonly durationMs: number
}

export interface ITextSearchMainService {
  readonly _serviceBrand: undefined
  readonly onDidSearchProgress: Event<ITextSearchMainProgressEvent>
  readonly onDidSearchResults: Event<ITextSearchMainResultsEvent>
  search(query: ITextSearchMainQuery): Promise<ITextSearchMainComplete>
  cancel(sessionId: string): Promise<void>
}

export const ITextSearchMainService =
  createDecorator<ITextSearchMainService>('textSearchMainService')
