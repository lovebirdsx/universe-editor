/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Shared view state for the Session Changes viewlet. The title toolbar lives in
 *  a separate React subtree from the body, so the view mode (list/tree) and the
 *  collapse/expand-all intents are held here as module-level observables rather
 *  than in component state — same shape as commitChangesViewState. Persistence
 *  of `viewMode` is driven by SessionChangesView (it owns the IStorageService
 *  dependency).
 *--------------------------------------------------------------------------------------------*/

import { observableValue, type IObservable } from '@universe-editor/platform'
import type { ChangesTreeViewMode } from '../changesTree/buildSnapshot.js'

export type SessionChangesViewMode = ChangesTreeViewMode

const _viewMode = observableValue<SessionChangesViewMode>('acp.sessionChanges.viewMode', 'list')
const _collapseAll = observableValue<number>('acp.sessionChanges.collapseAll', 0)
const _expandAll = observableValue<number>('acp.sessionChanges.expandAll', 0)

// Last focused file per session — the view remounts (and loses its TreeModel)
// whenever the active session changes, so "returning to the session" restores
// focus from here. Session-scoped only, bounded so a long session can't grow
// it without limit.
const MAX_REMEMBERED_SESSIONS = 50
const _focusedFileBySession = new Map<string, string>()

export const sessionChangesViewState = {
  viewMode: _viewMode as IObservable<SessionChangesViewMode>,
  /** Monotonic counters; each increment is a request to collapse / expand
   *  every folder in the file tree. */
  collapseAllSignal: _collapseAll as IObservable<number>,
  expandAllSignal: _expandAll as IObservable<number>,
  setViewMode(mode: SessionChangesViewMode): void {
    _viewMode.set(mode, undefined)
  },
  requestCollapseAll(): void {
    _collapseAll.set(_collapseAll.get() + 1, undefined)
  },
  requestExpandAll(): void {
    _expandAll.set(_expandAll.get() + 1, undefined)
  },
  rememberFocusedFile(sessionKey: string, path: string): void {
    _focusedFileBySession.delete(sessionKey)
    _focusedFileBySession.set(sessionKey, path)
    if (_focusedFileBySession.size > MAX_REMEMBERED_SESSIONS) {
      const oldest = _focusedFileBySession.keys().next().value
      if (oldest !== undefined) _focusedFileBySession.delete(oldest)
    }
  },
  focusedFileFor(sessionKey: string): string | undefined {
    return _focusedFileBySession.get(sessionKey)
  },
  _resetForTests(): void {
    _viewMode.set('list', undefined)
    _collapseAll.set(0, undefined)
    _expandAll.set(0, undefined)
    _focusedFileBySession.clear()
  },
}
