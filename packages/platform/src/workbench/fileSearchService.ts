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
}

export interface IFileSearchMatch {
  readonly resource: URI
  readonly fsPath: string
  readonly relativePath: string
  readonly basename: string
  readonly score: number
}

export interface IFileSearchComplete {
  readonly results: readonly IFileSearchMatch[]
  readonly limitHit: boolean
  readonly filesWalked: number
  readonly directoriesWalked: number
  readonly durationMs: number
  /** Why the walk ended early, when it did not run to completion. */
  readonly stopReason?: 'maxResults' | 'timeout' | 'canceled'
}

export interface IFileSearchService {
  readonly _serviceBrand: undefined
  search(query: IFileSearchQuery, token?: CancellationToken): Promise<IFileSearchComplete>
}

export const IFileSearchService = createDecorator<IFileSearchService>('fileSearchService')
