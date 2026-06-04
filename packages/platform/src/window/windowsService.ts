/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Application-scoped window management: enumerate open windows, focus / open
 *  windows, and quit the app. Inspired by VSCode's IWorkbenchEnvironmentService
 *  + native host services, but pared down to single-folder workspaces.
 *--------------------------------------------------------------------------------------------*/

import type { Event } from '../base/event.js'
import { createDecorator } from '../di/instantiation.js'
import type { URI, UriComponents } from '../base/uri.js'

/** Snapshot of one open application window. */
export interface IOpenWindowInfo {
  readonly id: number
  /** Folder open in the window, or null for an empty window. Crosses the wire as UriComponents. */
  readonly folder: UriComponents | null
  /** Display label (workspace name), or null for an empty window. */
  readonly name: string | null
}

/**
 * App-singleton window orchestration, served from the main process and consumed
 * by the renderer via `ProxyChannel.toService`. Unlike `IHostService` (per-window),
 * this covers cross-window concerns: which windows are open, switching between
 * them, opening folders in new windows, and quitting the whole app.
 *
 * Folder URIs cross the wire as `UriComponents`; the renderer revives them.
 */
export interface IWindowsService {
  readonly _serviceBrand: undefined

  /** Fires when a window opens, closes, or changes its workspace. */
  readonly onDidChangeWindows: Event<void>

  /** Snapshot of all currently open windows (for Switch Window / open-state markers). */
  getWindows(): Promise<readonly IOpenWindowInfo[]>

  /** Whether the renderer using this service belongs to the first window in this app session. */
  isCurrentWindowFirst(): Promise<boolean>

  /** Bring the window with the given id to the foreground. */
  focusWindow(id: number): Promise<void>

  /**
   * Open a window for `folder`. When `folder` is omitted the main process shows
   * a native folder picker first (cancelling is a no-op). If the resolved folder
   * is already open in some window, that window is focused instead of opening a
   * duplicate (single-writer-per-workspace constraint).
   */
  openWindow(folder?: URI | UriComponents): Promise<void>

  /** Quit the entire application, closing all windows. */
  quit(): Promise<void>
}

export const IWindowsService = createDecorator<IWindowsService>('windowsService')
