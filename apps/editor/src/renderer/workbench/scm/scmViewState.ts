/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Shared view state for the Source Control viewlet. The title toolbar lives in
 *  the view's title bar (a separate React subtree from the body), so the view
 *  mode (list/tree) and the "collapse all" intent are held here as module-level
 *  observables rather than in component state. Persistence of `viewMode` is
 *  driven by ScmView (it owns the IStorageService dependency).
 *--------------------------------------------------------------------------------------------*/

import { observableValue, type IObservable } from '@universe-editor/platform'
import type { ViewMode } from './scmShared.js'

const _viewMode = observableValue<ViewMode>('scm.viewMode', 'list')
const _collapseAll = observableValue<number>('scm.collapseAll', 0)
const _selectedRepo = observableValue<string | undefined>('scm.selectedRepo', undefined)

export const scmViewState = {
  viewMode: _viewMode as IObservable<ViewMode>,
  /** Monotonic counter; each increment is a request to collapse every folder. */
  collapseAllSignal: _collapseAll as IObservable<number>,
  /** rootUri of the repo the view currently shows; undefined falls back to the first. */
  selectedRepo: _selectedRepo as IObservable<string | undefined>,
  setViewMode(mode: ViewMode): void {
    _viewMode.set(mode, undefined)
  },
  requestCollapseAll(): void {
    _collapseAll.set(_collapseAll.get() + 1, undefined)
  },
  setSelectedRepo(rootUri: string | undefined): void {
    _selectedRepo.set(rootUri, undefined)
  },
}
