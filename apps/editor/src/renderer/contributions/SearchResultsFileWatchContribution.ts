/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SearchResultsFileWatchContribution — keeps the cached search results
 *  (searchSession) honest while the Search view is unmounted. The SideBar only
 *  mounts the active view, so deleting a file from Explorer unmounts SearchView
 *  and drops its own watcher subscription; without this contribution the
 *  session cache would restore matches for files that no longer exist. Content
 *  changes are intentionally not applied here — those belong to the mounted
 *  view's stale banner / re-run.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IFileWatcherService,
  IUriIdentityService,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import { searchSession } from '../workbench/search/searchSession.js'
import { deletedResources, removeDeletedMatches } from '../workbench/search/searchResultFilter.js'

export class SearchResultsFileWatchContribution
  extends Disposable
  implements IWorkbenchContribution
{
  constructor(
    @IFileWatcherService watcher: IFileWatcherService,
    @IUriIdentityService uriIdentity: IUriIdentityService,
  ) {
    super()
    this._register(
      watcher.onDidChangeFiles((events) => {
        if (searchSession.results.length === 0) return
        const deleted = deletedResources(events)
        if (deleted.length === 0) return
        searchSession.results = removeDeletedMatches(searchSession.results, deleted, uriIdentity)
      }),
    )
  }
}
