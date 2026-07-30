/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  ScmSelectedRepoContribution — hydrates + persists the SCM view's selected
 *  repo (per-workspace storage). This used to live in the ScmView component,
 *  which meant the selection was only restored once the user opened the SCM
 *  panel: with the panel hidden, dirty-diff/blame arbitration kept running on
 *  the longest-prefix fallback (e.g. git blame in a p4-selected workspace)
 *  until the panel got focus. The restore therefore lives at the workbench
 *  level, mirroring OutlineViewStateContribution.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IStorageService,
  StorageScope,
  autorun,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import { SELECTED_REPO_STORAGE_KEY, scmViewState } from '../workbench/scm/scmViewState.js'

export class ScmSelectedRepoContribution extends Disposable implements IWorkbenchContribution {
  constructor(@IStorageService private readonly _storage: IStorageService) {
    super()
    void this._hydrate()
  }

  private async _hydrate(): Promise<void> {
    const saved = await this._storage.get<string>(SELECTED_REPO_STORAGE_KEY, StorageScope.WORKSPACE)
    if (this._store.isDisposed) return
    // An in-memory choice made while the read was in flight wins over the
    // stale stored value.
    if (saved && scmViewState.selectedRepo.get() === undefined) {
      scmViewState.setSelectedRepo(saved)
    }
    // Persist every later change. No first-pass skip: the first pass writes the
    // just-settled value, which is also how a selection that raced hydration
    // (and won, above) still reaches storage.
    this._register(
      autorun((r) => {
        const selected = scmViewState.selectedRepo.read(r)
        if (selected === undefined) return
        void this._storage.set(SELECTED_REPO_STORAGE_KEY, selected, StorageScope.WORKSPACE)
      }),
    )
  }
}
