/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  OutlineViewStateContribution — persists the Outline view's user preferences
 *  (follow cursor / filter on type / sort order) to GLOBAL storage and hydrates
 *  them on startup, mirroring how VSCode stores the outline view state. The
 *  state itself lives in the module-level outlineViewState observables shared by
 *  the view body and its title-bar toolbar.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IStorageService,
  StorageScope,
  autorun,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import { outlineViewState, type OutlineSortOrder } from '../workbench/outline/outlineViewState.js'

const STORAGE_KEY = 'outline.viewState'

interface PersistedOutlineState {
  followCursor?: boolean
  filterOnType?: boolean
  sortBy?: OutlineSortOrder
}

const SORT_VALUES: ReadonlySet<string> = new Set(['position', 'name', 'kind'])

export class OutlineViewStateContribution extends Disposable implements IWorkbenchContribution {
  constructor(@IStorageService private readonly _storage: IStorageService) {
    super()
    void this._hydrate()
  }

  private async _hydrate(): Promise<void> {
    const saved = await this._storage.get<PersistedOutlineState>(STORAGE_KEY, StorageScope.GLOBAL)
    if (saved) {
      if (typeof saved.followCursor === 'boolean')
        outlineViewState.setFollowCursor(saved.followCursor)
      if (typeof saved.filterOnType === 'boolean')
        outlineViewState.setFilterOnType(saved.filterOnType)
      if (typeof saved.sortBy === 'string' && SORT_VALUES.has(saved.sortBy))
        outlineViewState.setSortBy(saved.sortBy)
    }

    // Write back on any preference change. Reading all three keeps them as
    // dependencies; the first autorun pass only observes the just-hydrated
    // values, so skip it to avoid echoing them straight back to storage.
    let firstPass = true
    this._register(
      autorun((r) => {
        const next: PersistedOutlineState = {
          followCursor: outlineViewState.followCursor.read(r),
          filterOnType: outlineViewState.filterOnType.read(r),
          sortBy: outlineViewState.sortBy.read(r),
        }
        if (firstPass) {
          firstPass = false
          return
        }
        void this._storage.set(STORAGE_KEY, next, StorageScope.GLOBAL)
      }),
    )
  }
}
