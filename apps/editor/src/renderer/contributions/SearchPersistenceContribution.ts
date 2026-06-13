/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SearchPersistenceContribution — hydrates the Search viewlet's persisted state
 *  (view mode, query history, "use exclude settings" toggle) from GLOBAL storage
 *  at startup so it survives across restarts. searchViewState owns the keys and
 *  the write-through; this contribution only attaches the store.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, IStorageService, IWorkbenchContribution } from '@universe-editor/platform'
import { searchViewState } from '../workbench/search/searchViewState.js'

export class SearchPersistenceContribution extends Disposable implements IWorkbenchContribution {
  constructor(@IStorageService storage: IStorageService) {
    super()
    void searchViewState.attachStorage(storage)
  }
}
