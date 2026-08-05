/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Keeps the shared workspace file listing (mentionFileSearch cache, consumed
 *  by Ctrl+P quick open and the @-mention popover) fresh and warm:
 *    - any file change / watcher restart invalidates the cache, so the long
 *      TTL never serves stale results for long;
 *    - once the workbench is idle, pre-warms the listing so the first Ctrl+P
 *      of a session doesn't pay the full disk walk.
 *--------------------------------------------------------------------------------------------*/

import {
  CancellationTokenSource,
  Disposable,
  IFileSearchService,
  IFileWatcherService,
  IWorkspaceService,
  runWhenIdle,
  toDisposable,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import {
  invalidateMentionFileCache,
  loadWorkspaceFiles,
} from '../services/acp/mentionFileSearch.js'
import { IExcludeService } from '../services/exclude/ExcludeService.js'

export class WorkspaceFileListingContribution extends Disposable implements IWorkbenchContribution {
  // Prewarm walks the whole workspace; on a pathological tree that is minutes
  // of main-process I/O, so it must die with the contribution, not linger.
  private readonly _prewarmCts = new CancellationTokenSource()

  constructor(
    @IWorkspaceService private readonly _workspace: IWorkspaceService,
    @IFileWatcherService private readonly _watcher: IFileWatcherService,
    @IFileSearchService private readonly _fileSearch: IFileSearchService,
    @IExcludeService private readonly _exclude: IExcludeService,
  ) {
    super()
    this._register(toDisposable(() => this._prewarmCts.dispose(true)))
    this._register(
      this._watcher.onDidChangeFiles(() =>
        invalidateMentionFileCache(this._workspace.current?.folder),
      ),
    )
    // Events during a watcher crash gap are lost — rebuild from scratch.
    this._register(
      this._watcher.onDidRestart(() => invalidateMentionFileCache(this._workspace.current?.folder)),
    )
    this._register(runWhenIdle(globalThis, () => void this._prewarm()))
  }

  private async _prewarm(): Promise<void> {
    await this._workspace.whenReady
    const root = this._workspace.current?.folder
    if (!root || this._store.isDisposed) return
    await loadWorkspaceFiles(
      root,
      this._fileSearch,
      {
        dirNames: this._exclude.getDirNameIgnores(),
        excludeGlobs: this._exclude.getSearchExcludeGlobs(),
      },
      this._prewarmCts.token,
    ).catch(() => undefined)
  }
}
