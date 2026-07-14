/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Renderer-side adapter for main-process workspace text search.
 *--------------------------------------------------------------------------------------------*/

import {
  ILoggerService,
  ITextSearchService,
  IWorkspaceService,
  InstantiationType,
  createNamedLogger,
  registerSingleton,
  type IFileMatch,
  type ILogger,
  type ILoggerService as ILoggerServiceType,
  type ITextSearchOptions,
  type ITextSearchQuery,
  type IWorkspaceService as IWorkspaceServiceType,
} from '@universe-editor/platform'
import {
  ITextSearchMainService,
  type ITextSearchMainService as ITextSearchMainServiceType,
} from '../../../shared/ipc/textSearchService.js'
import { compileQuery } from './scanText.js'
import { IExcludeService } from '../exclude/ExcludeService.js'

let searchSessionSeq = 0

export class TextSearchService implements ITextSearchService {
  declare readonly _serviceBrand: undefined

  private readonly _logger: ILogger

  constructor(
    @IWorkspaceService private readonly _workspace: IWorkspaceServiceType,
    @ITextSearchMainService private readonly _mainSearch: ITextSearchMainServiceType,
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
    const pattern = query.pattern.trim()
    if (pattern.length === 0) {
      this._logger.debug('search skipped emptyPattern')
      return []
    }

    try {
      compileQuery({ ...query, pattern })
    } catch {
      this._logger.warn('search skipped invalidQuery')
      return []
    }

    if (opts.signal?.aborted) {
      this._logger.info('search aborted beforeStart')
      return []
    }

    const startedAt = Date.now()
    const sessionId = `renderer-${Date.now().toString(36)}-${++searchSessionSeq}`
    const progressListener = this._mainSearch.onDidSearchProgress((event) => {
      if (event.sessionId !== sessionId) return
      opts.onProgress?.(event.progress)
    })
    const resultsListener = this._mainSearch.onDidSearchResults((event) => {
      if (event.sessionId !== sessionId) return
      if (opts.signal?.aborted) return
      opts.onResults?.(event.results)
    })
    const onAbort = (): void => {
      void this._mainSearch.cancel(sessionId).catch((err: unknown) => {
        this._logger.warn(`search cancel failed: ${(err as Error).message}`)
      })
    }

    opts.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      this._logger.info(
        `search start root=${root.toString()} includes=${query.includes.length} excludes=${query.excludes.length}`,
      )
      const complete = await this._mainSearch.search({
        ...query,
        sessionId,
        root: root.toJSON(),
        pattern,
        configurationExcludes:
          opts.useExcludeSettings === false ? [] : this._exclude.getSearchExcludeGlobs(),
      })
      opts.onProgress?.(complete.progress)
      this._logger.info(
        `search finished files=${complete.progress.filesScanned} ` +
          `matched=${complete.progress.filesMatched} matches=${complete.progress.totalMatches} ` +
          `limit=${complete.progress.limitHit ?? 'none'} ms=${Date.now() - startedAt}`,
      )
      return complete.results
    } catch (err) {
      if (opts.signal?.aborted) {
        this._logger.info('search aborted')
        return []
      }
      this._logger.warn(`search failed: ${(err as Error).message}`)
      throw err
    } finally {
      opts.signal?.removeEventListener('abort', onAbort)
      progressListener.dispose()
      resultsListener.dispose()
    }
  }
}

registerSingleton(ITextSearchService, TextSearchService, InstantiationType.Delayed)
