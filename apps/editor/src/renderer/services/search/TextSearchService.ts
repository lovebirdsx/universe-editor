/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Renderer-side adapter for main-process workspace text search.
 *--------------------------------------------------------------------------------------------*/

import {
  DisposableStore,
  IConfigurationService,
  IEditorGroupsService,
  ILoggerService,
  ITextSearchService,
  IUriIdentityService,
  IWorkspaceService,
  InstantiationType,
  createNamedLogger,
  markAsSingleton,
  registerSingleton,
  type IConfigurationService as IConfigurationServiceType,
  type IEditorGroupsService as IEditorGroupsServiceType,
  type IFileMatch,
  type ILogger,
  type ILoggerService as ILoggerServiceType,
  type ITextSearchOptions,
  type ITextSearchQuery,
  type IUriIdentityService as IUriIdentityServiceType,
  type IWorkspaceService as IWorkspaceServiceType,
} from '@universe-editor/platform'
import {
  ITextSearchMainService,
  type ITextSearchMainService as ITextSearchMainServiceType,
} from '@universe-editor/platform'
import { compileQuery } from './scanText.js'
import { mergeOpenEditorResults, searchOpenEditorModels } from './openEditorSearch.js'
import { IExcludeService } from '../exclude/ExcludeService.js'
import { IFocusScopeService } from '../focus/FocusScopeService.js'

let searchSessionSeq = 0

export class TextSearchService implements ITextSearchService {
  declare readonly _serviceBrand: undefined

  private readonly _logger: ILogger

  // Roots in-flight searches' event listeners under a singleton so the dev/E2E
  // leak tracker tolerates a not-yet-settled search at teardown; each search's
  // store is deleted in `finally`, so nothing accumulates.
  private readonly _searchStores = markAsSingleton(new DisposableStore())

  constructor(
    @IWorkspaceService private readonly _workspace: IWorkspaceServiceType,
    @ITextSearchMainService private readonly _mainSearch: ITextSearchMainServiceType,
    @IExcludeService private readonly _exclude: IExcludeService,
    @IEditorGroupsService private readonly _editorGroups: IEditorGroupsServiceType,
    @IUriIdentityService private readonly _uriIdentity: IUriIdentityServiceType,
    @IConfigurationService private readonly _config: IConfigurationServiceType,
    @ILoggerService loggerService: ILoggerServiceType,
    @IFocusScopeService private readonly _focus: IFocusScopeService,
  ) {
    this._logger = createNamedLogger(loggerService, { id: 'search', name: 'Search' })
  }

  async search(
    query: ITextSearchQuery,
    opts: ITextSearchOptions = {},
  ): Promise<readonly IFileMatch[]> {
    const root = this._workspace.current?.folder ?? null
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

    // Untitled / dirty buffers exist only in memory, so ripgrep can never see
    // them (or sees stale content). Search their models up front and fold the
    // results into the disk set at completion, VSCode getOpenEditorResults-style.
    const editorResults = searchOpenEditorModels(this._editorGroups, { ...query, pattern })
    if (editorResults.length > 0 && !opts.signal?.aborted) opts.onResults?.(editorResults)

    if (!root) {
      if (editorResults.length > 0) {
        this._logger.info(`search openEditorsOnly files=${editorResults.length}`)
      } else {
        this._logger.debug('search skipped noWorkspace')
      }
      return editorResults
    }

    const startedAt = Date.now()
    const sessionId = `renderer-${Date.now().toString(36)}-${++searchSessionSeq}`
    const searchStore = this._searchStores.add(new DisposableStore())
    searchStore.add(
      this._mainSearch.onDidSearchProgress((event) => {
        if (event.sessionId !== sessionId) return
        opts.onProgress?.(event.progress)
      }),
    )
    searchStore.add(
      this._mainSearch.onDidSearchResults((event) => {
        if (event.sessionId !== sessionId) return
        if (opts.signal?.aborted) return
        opts.onResults?.(event.results)
      }),
    )
    const onAbort = (): void => {
      // Release the IPC subscriptions immediately: the main-side search promise
      // may never settle once the caller aborts (e.g. the window is reloading),
      // so waiting for `finally` would leak them past teardown.
      this._searchStores.delete(searchStore)
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
        threads: this._config.get<number>('search.threads', 0) ?? 0,
        // The search view's toggle is labelled "use exclude settings and ignore
        // files", so turning it off has to drop the ignore files too — not just
        // the globs.
        useIgnoreFiles:
          opts.useExcludeSettings === false ? false : this._exclude.getUseIgnoreFiles(),
        ...(this._focus.active ? { scanPaths: [...this._focus.folders] } : {}),
        rootFilesInScope: this._focus.rootFilesInScope,
      })
      opts.onProgress?.(complete.progress)
      this._logger.info(
        `search finished files=${complete.progress.filesScanned} ` +
          `matched=${complete.progress.filesMatched} matches=${complete.progress.totalMatches} ` +
          `limit=${complete.progress.limitHit ?? 'none'} ms=${Date.now() - startedAt}`,
      )
      return mergeOpenEditorResults(complete.results, editorResults, this._uriIdentity)
    } catch (err) {
      if (opts.signal?.aborted) {
        this._logger.info('search aborted')
        return []
      }
      this._logger.warn(`search failed: ${(err as Error).message}`)
      throw err
    } finally {
      opts.signal?.removeEventListener('abort', onAbort)
      this._searchStores.delete(searchStore)
    }
  }
}

registerSingleton(ITextSearchService, TextSearchService, InstantiationType.Delayed)
