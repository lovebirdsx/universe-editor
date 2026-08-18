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
  /**
   * Normalized remote authority the window is scoped to — derived from a remote
   * workspace folder, or window-level for an empty remote-scoped window. Absent
   * for local windows.
   */
  readonly remoteAuthority?: string
}

/**
 * The most recent unexpected renderer-process exit of a window (Electron
 * `render-process-gone` with any reason other than `clean-exit`). Used by the
 * renderer to break crash loops — e.g. pausing auto-resume of a session whose
 * reload just OOMed. `at` is epoch milliseconds.
 */
export interface IWindowRenderCrashInfo {
  readonly reason: string
  readonly at: number
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

  /** This renderer's own window id (captured per-window by the main adapter). */
  getCurrentWindowId(): Promise<number>

  /**
   * The app's "top" window id: the OS-focused window, falling back to the last
   * focused (still-alive) window, then the first open window, else null.
   */
  getFocusedWindowId(): Promise<number | null>

  /** Fires with the window id whenever a window becomes the focused/top window. */
  readonly onDidChangeFocusedWindow: Event<number>

  /**
   * The most recent unexpected renderer exit of the calling window, or null
   * when it has not crashed (or the record aged out with the window).
   */
  getLastRenderCrash(): Promise<IWindowRenderCrashInfo | null>

  /** Bring the window with the given id to the foreground. */
  focusWindow(id: number): Promise<void>

  /**
   * Open a window for `folder`. When `folder` is omitted the main process shows
   * a native folder picker first (cancelling is a no-op). If the resolved folder
   * is already open in some window, that window is focused instead of opening a
   * duplicate (single-writer-per-workspace constraint).
   *
   * `options.sessionId` carries an ACP session id the target window should
   * resume once it is up (used to follow a cross-worktree session into the
   * window that owns its cwd). Delivered via argv on a fresh window or pushed
   * over IPC when an already-open window is focused instead.
   */
  openWindow(folder?: URI | UriComponents, options?: { sessionId?: string }): Promise<void>

  /** Quit the entire application, closing all windows. */
  quit(): Promise<void>
}

export const IWindowsService = createDecorator<IWindowsService>('windowsService')
