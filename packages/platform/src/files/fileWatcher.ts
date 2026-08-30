/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  IFileWatcherService — main-process file watcher reached from the renderer
 *  via `ProxyChannel.toService`. The renderer drives the recursive watch on the
 *  active workspace root; switching workspaces calls `watch()` again which
 *  replaces the previous handle.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../di/instantiation.js'
import type { Event } from '../base/event.js'
import type { URI } from '../base/uri.js'

export type FileChangeType = 'added' | 'deleted' | 'modified'

export interface IFileChangeEvent {
  readonly type: FileChangeType
  readonly resource: URI
}

export interface IWatchOptions {
  /**
   * Glob patterns (workspace-relative); matching paths are dropped before any
   * change event is emitted.
   */
  readonly excludes?: readonly string[]

  /**
   * Subtrees of `folder` to watch recursively instead of `folder` itself —
   * the resolved focus folders (see IFocusScopeService). Each becomes its own
   * subscription, so a huge workspace only pays for the parts in scope. Nested
   * entries collapse into the shallowest one. Omit (or pass empty) to watch
   * `folder` itself, which is the unfocused default.
   */
  readonly scopes?: readonly URI[]

  /**
   * Also watch `folder` non-recursively, to catch changes to files sitting
   * directly in it. Only meaningful alongside `scopes`, which otherwise leave
   * the root itself uncovered.
   */
  readonly includeRootFiles?: boolean
}

export interface IFileWatcherService {
  readonly _serviceBrand: undefined

  /**
   * Replace the current watch with a recursive watch on `folder` — or, when
   * `options.scopes` is given, on those subtrees of it. No-op if the resolved
   * target set and excludes are unchanged. `folder` remains the workspace root
   * for identity purposes regardless of scopes. URIs marshal across the IPC
   * boundary automatically.
   */
  watch(folder: URI, options?: IWatchOptions): Promise<void>

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
   * Files already covered by the active workspace watch are skipped
   * automatically. Pass an empty array to clear all extra watches. Events from
   * these paths are emitted through `onDidChangeFiles` alongside workspace
   * events.
   */
  watchOutOfWorkspace(uris: readonly URI[]): Promise<void>

  /**
   * Arm a recursive watch on an additional (out-of-workspace) folder (backs
   * `workspace.createFileSystemWatcher` with a `RelativePattern` base outside
   * the workspace). Folders already covered by the active workspace watch are
   * skipped automatically. Reference counting and dedupe are the caller's job:
   * each `addOutOfWorkspaceFolder` pairs with one `removeOutOfWorkspaceFolder`.
   * Nested folders collapse into the shallowest armed watch. Events for files
   * under these folders are emitted through `onDidChangeFiles` alongside
   * workspace events.
   */
  addOutOfWorkspaceFolder(folder: URI): Promise<void>

  /** Release a folder previously armed via {@link addOutOfWorkspaceFolder}. */
  removeOutOfWorkspaceFolder(folder: URI): Promise<void>

  /** Release every armed out-of-workspace folder watch at once. */
  clearOutOfWorkspaceFolders(): Promise<void>

  /**
   * Fires for every batch of debounced filesystem events. The same resource
   * may appear at most once per batch; consumers should treat ordering across
   * batches as best-effort.
   */
  readonly onDidChangeFiles: Event<readonly IFileChangeEvent[]>

  /**
   * Fires after the underlying watcher process crashed and was restarted with
   * the subscription re-armed. Filesystem events during the gap are lost —
   * consumers holding a materialized view (e.g. an explorer tree) should
   * rescan on this signal.
   */
  readonly onDidRestart: Event<void>
}

export const IFileWatcherService = createDecorator<IFileWatcherService>('fileWatcherService')
