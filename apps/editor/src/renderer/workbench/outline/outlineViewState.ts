/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Shared view state for the Outline viewlet. The title toolbar lives in the
 *  view's title bar (a separate React subtree from the body), so the user
 *  preferences (follow cursor / filter on type / sort order) and the
 *  collapse-all / expand-all intents are held here as module-level observables
 *  rather than in component state — mirroring searchViewState. The persisted
 *  preferences are hydrated / written back by OutlineViewStateContribution.
 *--------------------------------------------------------------------------------------------*/

import { observableValue, type IObservable } from '@universe-editor/platform'

export type OutlineSortOrder = 'position' | 'name' | 'kind'

const _followCursor = observableValue<boolean>('outline.followCursor', true)
const _filterOnType = observableValue<boolean>('outline.filterOnType', true)
const _sortBy = observableValue<OutlineSortOrder>('outline.sortBy', 'position')
const _allCollapsed = observableValue<boolean>('outline.allCollapsed', false)
const _collapseAll = observableValue<number>('outline.collapseAll', 0)
const _expandAll = observableValue<number>('outline.expandAll', 0)

export const outlineViewState = {
  followCursor: _followCursor as IObservable<boolean>,
  filterOnType: _filterOnType as IObservable<boolean>,
  sortBy: _sortBy as IObservable<OutlineSortOrder>,
  /** Whether every expandable node is currently collapsed (drives the toolbar icon). Written by the view body. */
  allCollapsed: _allCollapsed as IObservable<boolean>,
  /** Monotonic counter; each increment is a request to collapse every node. */
  collapseAllSignal: _collapseAll as IObservable<number>,
  /** Monotonic counter; each increment is a request to expand every node. */
  expandAllSignal: _expandAll as IObservable<number>,
  setFollowCursor(value: boolean): void {
    _followCursor.set(value, undefined)
  },
  setFilterOnType(value: boolean): void {
    _filterOnType.set(value, undefined)
  },
  setSortBy(value: OutlineSortOrder): void {
    _sortBy.set(value, undefined)
  },
  setAllCollapsed(value: boolean): void {
    _allCollapsed.set(value, undefined)
  },
  requestCollapseAll(): void {
    _collapseAll.set(_collapseAll.get() + 1, undefined)
  },
  requestExpandAll(): void {
    _expandAll.set(_expandAll.get() + 1, undefined)
  },
}
