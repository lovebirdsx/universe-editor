/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Shared view state for the Search viewlet. The title toolbar lives in the
 *  view's title bar (a separate React subtree from the body), so view mode
 *  (list/tree) and the collapse-all / clear / refresh intents are held here as
 *  module-level observables rather than in component state — mirroring scmViewState.
 *
 *  view mode, search history and the "use exclude settings" toggle are also
 *  persisted to GLOBAL storage so they survive across restarts. The store is
 *  attached once by SearchPersistenceContribution at startup; until then reads
 *  return the in-memory defaults and writes are no-ops.
 *--------------------------------------------------------------------------------------------*/

import {
  StorageScope,
  observableValue,
  type IObservable,
  type IStorageService,
} from '@universe-editor/platform'

export type SearchViewMode = 'list' | 'tree'

const VIEW_MODE_KEY = 'search.viewMode'
const HISTORY_KEY = 'search.history'
const USE_EXCLUDE_KEY = 'search.useExcludeSettings'
const HISTORY_LIMIT = 50

const _viewMode = observableValue<SearchViewMode>('search.viewMode', 'list')
const _collapseAll = observableValue<number>('search.collapseAll', 0)
const _clear = observableValue<number>('search.clear', 0)
const _refresh = observableValue<number>('search.refresh', 0)
const _hasResults = observableValue<boolean>('search.hasResults', false)
const _useExcludeSettings = observableValue<boolean>('search.useExcludeSettings', true)
const _history = observableValue<readonly string[]>('search.history', [])
const _seed = observableValue<number>('search.seed', 0)

let _storage: IStorageService | null = null

function persist(key: string, value: unknown): void {
  void _storage?.set(key, value, StorageScope.GLOBAL)
}

export const searchViewState = {
  viewMode: _viewMode as IObservable<SearchViewMode>,
  /** Monotonic counter; each increment is a request to collapse every node. */
  collapseAllSignal: _collapseAll as IObservable<number>,
  /** Monotonic counter; each increment clears the query and results. */
  clearSignal: _clear as IObservable<number>,
  /** Monotonic counter; each increment re-runs the current search. */
  refreshSignal: _refresh as IObservable<number>,
  /** Whether the results tree currently has any matches (drives toolbar enablement). */
  hasResults: _hasResults as IObservable<boolean>,
  /** Whether files.exclude / search.exclude globs are applied to the search. */
  useExcludeSettings: _useExcludeSettings as IObservable<boolean>,
  /** Most-recent-first ring of accepted search queries. */
  history: _history as IObservable<readonly string[]>,
  /** Monotonic counter; each increment asks a mounted SearchView to consume searchSession.seedPattern. */
  seedSignal: _seed as IObservable<number>,

  /** Bind the persistent store and hydrate the persisted observables from it. */
  async attachStorage(storage: IStorageService): Promise<void> {
    _storage = storage
    const [mode, history, useExclude] = await Promise.all([
      storage.get<SearchViewMode>(VIEW_MODE_KEY, StorageScope.GLOBAL),
      storage.get<readonly string[]>(HISTORY_KEY, StorageScope.GLOBAL),
      storage.get<boolean>(USE_EXCLUDE_KEY, StorageScope.GLOBAL),
    ])
    if (mode === 'list' || mode === 'tree') _viewMode.set(mode, undefined)
    if (Array.isArray(history)) _history.set(history.slice(0, HISTORY_LIMIT), undefined)
    if (typeof useExclude === 'boolean') _useExcludeSettings.set(useExclude, undefined)
  },

  setViewMode(mode: SearchViewMode): void {
    _viewMode.set(mode, undefined)
    persist(VIEW_MODE_KEY, mode)
  },
  setUseExcludeSettings(value: boolean): void {
    _useExcludeSettings.set(value, undefined)
    persist(USE_EXCLUDE_KEY, value)
  },
  /** Record an accepted query at the front of the history ring (deduped). */
  addHistory(query: string): void {
    const trimmed = query.trim()
    if (trimmed.length === 0) return
    const next = [trimmed, ..._history.get().filter((q) => q !== trimmed)].slice(0, HISTORY_LIMIT)
    _history.set(next, undefined)
    persist(HISTORY_KEY, next)
  },
  requestCollapseAll(): void {
    _collapseAll.set(_collapseAll.get() + 1, undefined)
  },
  requestClear(): void {
    _clear.set(_clear.get() + 1, undefined)
  },
  requestRefresh(): void {
    _refresh.set(_refresh.get() + 1, undefined)
  },
  setHasResults(value: boolean): void {
    _hasResults.set(value, undefined)
  },
  /** Ask a mounted SearchView to apply searchSession.seedPattern (set by FindInFilesAction). */
  requestSeed(): void {
    _seed.set(_seed.get() + 1, undefined)
  },
}
