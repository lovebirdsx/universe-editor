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
   * No-op if the new folder equals the current one.
   */
  watch(folder: UriComponents): Promise<void>

  /** Stop watching. Safe to call when no watch is active. */
  unwatch(): Promise<void>

  /**
   * Fires for every batch of debounced filesystem events. The same resource
   * may appear at most once per batch; consumers should treat ordering across
   * batches as best-effort.
   */
  readonly onDidChangeFiles: Event<readonly IFileChangeEvent[]>
}

export const IFileWatcherService = createDecorator<IFileWatcherService>('fileWatcherService')
