/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Inspired by VSCode's IWorkspaceContextService (platform/workspace).
 *--------------------------------------------------------------------------------------------*/

import type { Event } from '../base/event.js'
import { createDecorator } from '../di/instantiation.js'
import type { URI, UriComponents } from '../base/uri.js'

export interface IWorkspace {
  readonly folder: URI
  /** Display label — usually `basename(folder.fsPath)`. */
  readonly name: string
}

export interface IRecentWorkspace {
  readonly folder: URI
  readonly name: string
  /** Last-opened time as epoch milliseconds. Used for ordering. */
  readonly lastOpened: number
}

/**
 * Single-folder workspace state. The current folder (if any), an LRU list of
 * recently opened folders, and lifecycle commands to open / close / clear.
 *
 * Multi-root workspaces (.code-workspace) are intentionally out of scope.
 *
 * `current` / `recent` are synchronous on the renderer side — a small wrapper
 * keeps a local cache updated via the change events. The cross-process wire
 * variant (`IWorkspaceServiceWire`) exposes async `getCurrent` / `getRecent`
 * for the initial hydration instead.
 */
export interface IWorkspaceService {
  readonly _serviceBrand: undefined

  readonly current: IWorkspace | null
  readonly onDidChangeWorkspace: Event<IWorkspace | null>

  readonly recent: readonly IRecentWorkspace[]
  readonly onDidChangeRecent: Event<readonly IRecentWorkspace[]>

  /**
   * Resolves once the initial cross-process workspace hydration has settled,
   * whether or not a workspace ended up being loaded. Services that need a
   * startup-time cwd should await this before reading `current` — otherwise
   * they race the renderer's first IPC roundtrip to the main process.
   */
  readonly whenReady: Promise<void>

  /** When `folder` is undefined, the main process surfaces an Open Folder dialog. */
  openFolder(folder?: URI): Promise<void>
  closeFolder(): Promise<void>
  /** Remove a single entry from the recent list (VSCode "Remove from Recently Opened"). */
  removeRecent(folder: URI): Promise<void>
  clearRecent(): Promise<void>
}

export const IWorkspaceService = createDecorator<IWorkspaceService>('workspaceService')

/**
 * Cross-process subset of `IWorkspaceService`. The renderer pulls initial state
 * via `getCurrent` / `getRecent` and keeps it fresh through the change events;
 * the synchronous getters live on the renderer-side wrapper.
 *
 * Folder URIs cross the wire as `UriComponents`; the main implementation
 * revives them with `URI.revive`.
 */
export interface IWorkspaceServiceWire {
  readonly _serviceBrand: undefined

  readonly onDidChangeWorkspace: Event<IWorkspace | null>
  readonly onDidChangeRecent: Event<readonly IRecentWorkspace[]>

  getCurrent(): Promise<IWorkspace | null>
  getRecent(): Promise<readonly IRecentWorkspace[]>
  openFolder(folder?: URI | UriComponents): Promise<void>
  closeFolder(): Promise<void>
  removeRecent(folder: URI | UriComponents): Promise<void>
  clearRecent(): Promise<void>
}
