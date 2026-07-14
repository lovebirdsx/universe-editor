/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Wire contract for main-process text search sessions.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '@universe-editor/platform'
import type {
  Event,
  IFileMatch,
  ITextSearchProgress,
  ITextSearchQuery,
  UriComponents,
} from '@universe-editor/platform'

export interface ITextSearchMainQuery extends ITextSearchQuery {
  readonly sessionId: string
  readonly root: UriComponents
  readonly configurationExcludes: readonly string[]
  readonly maxFileSizeBytes?: number
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
