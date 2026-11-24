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

/** Workspace-storage key for the selected repo rootUri. Persistence lives in
 *  ScmSelectedRepoContribution (workbench level, not the view component), so
 *  the selection is restored even when the SCM panel never mounts. */
export const SELECTED_REPO_STORAGE_KEY = 'scm.selectedRepo'

/** A request to reveal a file row in the changes list; `fsPath` null means "no
 *  matching file — just focus the view". `tick` lets the same path re-trigger.
 *  `focusInput` forces the commit box instead of the remembered focus region
 *  (the AI bridge uses it before streaming a generated message there). */
export interface IScmRevealRequest {
  readonly fsPath: string | null
  readonly tick: number
  readonly focusInput?: boolean
}
const _reveal = observableValue<IScmRevealRequest | null>('scm.reveal', null)

export const scmViewState = {
  viewMode: _viewMode as IObservable<ViewMode>,
  /** Monotonic counter; each increment is a request to collapse every folder. */
  collapseAllSignal: _collapseAll as IObservable<number>,
  /** rootUri of the repo the view currently shows; undefined falls back to the first. */
  selectedRepo: _selectedRepo as IObservable<string | undefined>,
  /** Latest reveal request issued by the show-SCM command. */
  revealRequest: _reveal as IObservable<IScmRevealRequest | null>,
  /** Synchronous read for command-style consumers (e.g. the focus getter). */
  getRevealRequest(): IScmRevealRequest | null {
    return _reveal.get()
  },
  setViewMode(mode: ViewMode): void {
    _viewMode.set(mode, undefined)
  },
  requestCollapseAll(): void {
    _collapseAll.set(_collapseAll.get() + 1, undefined)
  },
  setSelectedRepo(rootUri: string | undefined): void {
    _selectedRepo.set(rootUri, undefined)
  },
  requestReveal(fsPath: string | null, options?: { focusInput?: boolean }): void {
    _reveal.set(
      {
        fsPath,
        tick: (_reveal.get()?.tick ?? 0) + 1,
        ...(options?.focusInput === true ? { focusInput: true } : {}),
      },
      undefined,
    )
  },
  _resetForTests(): void {
    _viewMode.set('list', undefined)
    _collapseAll.set(0, undefined)
    _selectedRepo.set(undefined, undefined)
    _reveal.set(null, undefined)
  },
}
