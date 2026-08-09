/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Module-level store for the Commit Changes sidebar view: the
 *  `_workbench.showCommitChanges` bridge action writes the payload here and the
 *  view (a separate React subtree, possibly not yet mounted) consumes it. The
 *  title-bar toolbar is yet another React subtree, so the view mode (tree/list)
 *  and the collapse/expand-all intents live here as observables too — same
 *  shape as scmViewState. Persistence of `viewMode` is driven by
 *  CommitChangesView (it owns the IStorageService dependency).
 *--------------------------------------------------------------------------------------------*/

import { observableValue, type IObservable } from '@universe-editor/platform'
import type { ShowCommitChangesPayload } from '@universe-editor/extensions-common'
import type { ChangesTreeViewMode } from '../../changesTree/buildSnapshot.js'

export type CommitChangesViewMode = ChangesTreeViewMode

/** GLOBAL-storage key for the view mode; mirrors ScmView's 'scm.viewMode'. */
export const COMMIT_CHANGES_VIEW_MODE_STORAGE_KEY = 'scm.commitChanges.viewMode'

const _payload = observableValue<ShowCommitChangesPayload | null>('commitChanges.payload', null)
const _tick = observableValue<number>('commitChanges.tick', 0)
const _viewMode = observableValue<CommitChangesViewMode>('commitChanges.viewMode', 'tree')
const _collapseAll = observableValue<number>('commitChanges.collapseAll', 0)
const _expandAll = observableValue<number>('commitChanges.expandAll', 0)

// Last focused file per commit — the view remounts (and loses its TreeModel)
// on every show(), so "returning to the view" restores focus from here.
// Session-scoped only, bounded so a long session can't grow it without limit.
const MAX_REMEMBERED_COMMITS = 50
const _focusedFileByCommit = new Map<string, string>()

export const commitChangesViewState = {
  payload: _payload as IObservable<ShowCommitChangesPayload | null>,
  /** Monotonic counter bumped by every show() — same-commit re-triggers must
   *  still re-reveal / reset the tree, so identity is tick, not payload. */
  tick: _tick as IObservable<number>,
  viewMode: _viewMode as IObservable<CommitChangesViewMode>,
  /** Monotonic counters; each increment is a request to collapse / expand
   *  every folder in the file tree. */
  collapseAllSignal: _collapseAll as IObservable<number>,
  expandAllSignal: _expandAll as IObservable<number>,
  show(p: ShowCommitChangesPayload): void {
    _payload.set(p, undefined)
    _tick.set(_tick.get() + 1, undefined)
  },
  clear(): void {
    _payload.set(null, undefined)
  },
  setViewMode(mode: CommitChangesViewMode): void {
    _viewMode.set(mode, undefined)
  },
  requestCollapseAll(): void {
    _collapseAll.set(_collapseAll.get() + 1, undefined)
  },
  requestExpandAll(): void {
    _expandAll.set(_expandAll.get() + 1, undefined)
  },
  rememberFocusedFile(commitRef: string, path: string): void {
    _focusedFileByCommit.delete(commitRef)
    _focusedFileByCommit.set(commitRef, path)
    if (_focusedFileByCommit.size > MAX_REMEMBERED_COMMITS) {
      const oldest = _focusedFileByCommit.keys().next().value
      if (oldest !== undefined) _focusedFileByCommit.delete(oldest)
    }
  },
  focusedFileFor(commitRef: string): string | undefined {
    return _focusedFileByCommit.get(commitRef)
  },
  _resetForTests(): void {
    _payload.set(null, undefined)
    _tick.set(0, undefined)
    _viewMode.set('tree', undefined)
    _collapseAll.set(0, undefined)
    _expandAll.set(0, undefined)
    _focusedFileByCommit.clear()
  },
}
