/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  IFileWatcherService — main-process file watcher reached from the renderer
 *  via `ProxyChannel.toService`. The renderer drives a single recursive watch
 *  on the active workspace root; switching workspaces calls `watch()` again
 *  which replaces the previous handle.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../di/instantiation.js'
import type { Event } from '../base/event.js'
import type { UriComponents } from '../base/uri.js'

export type FileChangeType = 'added' | 'deleted' | 'modified'

export interface IFileChangeEvent {
  readonly type: FileChangeType
  readonly resource: UriComponents
}

export interface IFileWatcherService {
  readonly _serviceBrand: undefined

  /**
   * Replace the current watch with a recursive watch on `folder`. Pass a
   * `file:` URI as `UriComponents` so the call works across the IPC boundary.
   * No-op if the new folder equals the current one. `options.excludes` are
   * glob patterns (workspace-relative); matching paths are dropped before any
   * change event is emitted.
   */
  watch(folder: UriComponents, options?: { excludes?: readonly string[] }): Promise<void>

  /**
   * Update the exclude globs applied to the active watch without tearing down
   * the underlying FSWatcher. Used for config hot-reload while the workspace
   * stays the same (where `watch()` would no-op on an identical folder).
   */
  setExcludes(excludes: readonly string[]): Promise<void>

  /** Stop watching. Safe to call when no watch is active. */
  unwatch(): Promise<void>

  /**
   * Replace the set of additional (out-of-workspace) file paths to watch.
   * Files already under the active workspace root are skipped automatically.
   * Pass an empty array to clear all extra watches. Events from these paths
   * are emitted through `onDidChangeFiles` alongside workspace events.
   */
  watchOutOfWorkspace(uris: readonly UriComponents[]): Promise<void>

  /**
   * Fires for every batch of debounced filesystem events. The same resource
   * may appear at most once per batch; consumers should treat ordering across
   * batches as best-effort.
   */
  readonly onDidChangeFiles: Event<readonly IFileChangeEvent[]>
}

export const IFileWatcherService = createDecorator<IFileWatcherService>('fileWatcherService')
