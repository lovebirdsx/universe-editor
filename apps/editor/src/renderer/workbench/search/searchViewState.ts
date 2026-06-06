/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Shared view state for the Search viewlet. The title toolbar lives in the
 *  view's title bar (a separate React subtree from the body), so view mode
 *  (list/tree) and the collapse-all / clear / refresh intents are held here as
 *  module-level observables rather than in component state — mirroring scmViewState.
 *--------------------------------------------------------------------------------------------*/

import { observableValue, type IObservable } from '@universe-editor/platform'

export type SearchViewMode = 'list' | 'tree'

const _viewMode = observableValue<SearchViewMode>('search.viewMode', 'list')
const _collapseAll = observableValue<number>('search.collapseAll', 0)
const _clear = observableValue<number>('search.clear', 0)
const _refresh = observableValue<number>('search.refresh', 0)
const _hasResults = observableValue<boolean>('search.hasResults', false)

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
  setViewMode(mode: SearchViewMode): void {
    _viewMode.set(mode, undefined)
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
}
