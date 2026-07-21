/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  WindowSessionStore: owns the multi-window session persistence — the debounced
 *  write of "which windows (workspace + geometry + devtools) are open" plus the
 *  per-workspace geometry cache used to reopen a closed folder where the user left
 *  it. Pure state read/write over the app-singleton storage: it snapshots the live
 *  windows on demand (via the injected source) and never touches window lifecycle.
 *  Extracted from WindowMainService (roadmap 06 · task 2) to keep the persistence
 *  concern independently testable.
 *--------------------------------------------------------------------------------------------*/

import type { BrowserWindow } from 'electron'
import { captureWindowState, type IWindowState } from '../../windowState.js'
import { getDefaultStorage, workspaceIdFromUri } from '../../storage.js'
import {
  serializeWindow,
  saveWorkspaceGeometry,
  WINDOWS_SESSION_STORAGE_KEY,
  type IPersistedWindow,
} from '../../windowsSession.js'
import type { WorkspaceMainService } from '../workspace/workspaceMainService.js'

const SESSION_PERSIST_DEBOUNCE_MS = 300

/** A live window paired with its workspace stack, for a persistence snapshot. */
export interface IWindowSnapshotEntry {
  readonly win: BrowserWindow
  readonly workspace: WorkspaceMainService
}

export class WindowSessionStore {
  private _timer: ReturnType<typeof setTimeout> | null = null

  /**
   * @param _snapshot Returns the currently-open windows to persist. Called at
   *   write time so the store always sees the live set (never a stale copy).
   */
  constructor(private readonly _snapshot: () => Iterable<IWindowSnapshotEntry>) {}

  /** Debounce a session write; coalesces bursts (workspace + geometry + devtools). */
  schedule(): void {
    if (this._timer !== null) clearTimeout(this._timer)
    this._timer = setTimeout(() => {
      this._timer = null
      void this.persistNow()
    }, SESSION_PERSIST_DEBOUNCE_MS)
  }

  /**
   * Write the session list + per-workspace geometry now, cancelling any pending
   * debounce. `captureWindowState` runs synchronously (readable only while the
   * window is live), so callers on the close path must invoke this before teardown.
   */
  async persistNow(): Promise<void> {
    this.cancel()
    const list: IPersistedWindow[] = []
    // Per-workspace geometry updates, keyed by workspaceId. Captured alongside
    // the session list so that reopening a closed workspace (while the app keeps
    // running) restores its last position/size — the session list only holds
    // currently-open windows and forgets a closed one.
    const geometryUpdates: Array<{ workspaceId: string; state: IWindowState }> = []
    for (const { win, workspace } of this._snapshot()) {
      if (win.isDestroyed()) continue
      const state = captureWindowState(win)
      list.push(serializeWindow(workspace.current, state, win.webContents.isDevToolsOpened()))
      if (workspace.current) {
        geometryUpdates.push({
          workspaceId: workspaceIdFromUri(workspace.current.folder.toString()),
          state,
        })
      }
    }
    const storage = getDefaultStorage()
    await storage.set(WINDOWS_SESSION_STORAGE_KEY, list)
    for (const { workspaceId, state } of geometryUpdates) {
      await saveWorkspaceGeometry(storage, workspaceId, state)
    }
  }

  /** Cancel any pending debounced write (on dispose, or before an eager persist). */
  cancel(): void {
    if (this._timer !== null) {
      clearTimeout(this._timer)
      this._timer = null
    }
  }
}
