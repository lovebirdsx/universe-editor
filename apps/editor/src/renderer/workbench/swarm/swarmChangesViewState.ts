/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Module-level store for the Swarm Changes sidebar view: the Swarm Reviews tree
 *  writes the focused review id here and the changes view (a separate React
 *  subtree) consumes it. The title-bar toolbar is yet another subtree, so the
 *  view mode (tree/list) and the collapse/expand-all intents live here as
 *  observables too — same shape as commitChangesViewState. Persistence of
 *  `viewMode` is driven by SwarmChangesView (it owns the IStorageService
 *  dependency).
 *--------------------------------------------------------------------------------------------*/

import { observableValue, type IObservable } from '@universe-editor/platform'
import type { ChangesTreeViewMode } from '../changesTree/buildSnapshot.js'

export type SwarmChangesViewMode = ChangesTreeViewMode

/** GLOBAL-storage key for the view mode; mirrors 'scm.commitChanges.viewMode'. */
export const SWARM_CHANGES_VIEW_MODE_STORAGE_KEY = 'swarm.swarmChanges.viewMode'

const _selectedReviewId = observableValue<string | null>('swarmChanges.selectedReviewId', null)
const _tick = observableValue<number>('swarmChanges.tick', 0)
const _viewMode = observableValue<SwarmChangesViewMode>('swarmChanges.viewMode', 'tree')
const _collapseAll = observableValue<number>('swarmChanges.collapseAll', 0)
const _expandAll = observableValue<number>('swarmChanges.expandAll', 0)

// Last focused file per review — the view remounts (and loses its TreeModel) on
// every select(), so "coming back to this review" restores focus from here.
// Session-scoped only, bounded so a long session can't grow it without limit.
const MAX_REMEMBERED_REVIEWS = 50
const _focusedFileByReview = new Map<string, string>()

export const swarmChangesViewState = {
  /** The review whose changes the view shows; null before anything is selected. */
  selectedReviewId: _selectedReviewId as IObservable<string | null>,
  /** Monotonic counter bumped by every select() — re-selecting the same review
   *  must still remount the tree, so the remount identity is tick, not the id. */
  tick: _tick as IObservable<number>,
  viewMode: _viewMode as IObservable<SwarmChangesViewMode>,
  /** Monotonic counters; each increment is a request to collapse / expand
   *  every folder in the file tree. */
  collapseAllSignal: _collapseAll as IObservable<number>,
  expandAllSignal: _expandAll as IObservable<number>,
  select(reviewId: string | null): void {
    // Re-selecting the already-shown review is a no-op: the reviews tree fires a
    // selection event on every focus move, and remounting the file tree each
    // time would drop its scroll position and folder state for nothing.
    if (_selectedReviewId.get() === reviewId) return
    _selectedReviewId.set(reviewId, undefined)
    _tick.set(_tick.get() + 1, undefined)
  },
  setViewMode(mode: SwarmChangesViewMode): void {
    _viewMode.set(mode, undefined)
  },
  requestCollapseAll(): void {
    _collapseAll.set(_collapseAll.get() + 1, undefined)
  },
  requestExpandAll(): void {
    _expandAll.set(_expandAll.get() + 1, undefined)
  },
  rememberFocusedFile(reviewId: string, path: string): void {
    _focusedFileByReview.delete(reviewId)
    _focusedFileByReview.set(reviewId, path)
    if (_focusedFileByReview.size > MAX_REMEMBERED_REVIEWS) {
      const oldest = _focusedFileByReview.keys().next().value
      if (oldest !== undefined) _focusedFileByReview.delete(oldest)
    }
  },
  focusedFileFor(reviewId: string): string | undefined {
    return _focusedFileByReview.get(reviewId)
  },
  _resetForTests(): void {
    _selectedReviewId.set(null, undefined)
    _tick.set(0, undefined)
    _viewMode.set('tree', undefined)
    _collapseAll.set(0, undefined)
    _expandAll.set(0, undefined)
    _focusedFileByReview.clear()
  },
}
