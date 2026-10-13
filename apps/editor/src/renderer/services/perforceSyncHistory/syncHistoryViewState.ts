/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Renderer-side, in-memory view state for the Perforce Sync History editor.
 *  The component unmounts whenever its tab is deactivated (only the active
 *  editor renders), which would otherwise re-fetch the page, drop the selection
 *  and jump the scroll back to the top on every return.
 *
 *  A single bucket, unlike `perforceGraphViewState`: this tab is a true
 *  singleton — its input id is the constant `universe:/perforceSyncHistory` URI
 *  with no scope in the query — so there is only ever one instance to remember.
 *  If it is ever opened per-scope, this becomes that file's keyed map.
 *--------------------------------------------------------------------------------------------*/

import type { P4SyncRunDto } from '@universe-editor/extensions-common'

/** Page size for the first load and each "Load more". */
export const SYNC_HISTORY_PAGE_SIZE = 50

/** `max` for the CSV export: the extension keeps at most this many records
 *  (`MAX_ENTRIES` in `extensions/perforce/src/syncHistory.ts`), so asking for
 *  200 is asking for the whole history. Raise it if that cap ever grows. */
export const SYNC_HISTORY_EXPORT_MAX = 200

/** Merge window in front of a poke-driven reload: records landing within this
 *  window of the first poke reload the page once. The window is anchored at that
 *  first poke rather than pushed back by each one, so a burst costs one reload
 *  and still lands within a quarter second. A get recorded after the window (the
 *  clobber remedy's force retry sits behind a dialog) reloads again — as it
 *  should, that is a second thing that happened. */
export const SYNC_HISTORY_POKE_DEBOUNCE_MS = 250

export interface PerforceSyncHistoryViewState {
  /** Callback registered by the mounted editor to focus the row list, used by
   *  `PerforceSyncHistoryEditorInput.focus()` so opening or activating the tab
   *  lands keyboard focus on the runs (arrow keys work without a prior click). */
  focusRows: (() => void) | null
  /** Callback registered by the mounted editor to reload the page (toolbar Refresh). */
  refresh: (() => void) | null
  /** The loaded page, newest first. Empty until the first load settles. */
  runs: P4SyncRunDto[]
  /** Matching runs in total, as the extension counted them (not `runs.length`). */
  total: number
  hasMore: boolean
  /** Selected run id, or null before the first selection. */
  selectedId: string | null
  /** Page size the page is showing or has already asked for; "Load more" raises
   *  it by one page. Written when a load is DISPATCHED, not when it answers: a
   *  poke-driven reload reads it while the user's load is still in flight, and a
   *  stale value there would shrink the page back. */
  limit: number
  /** True once a load has settled, so an empty list can say "none yet" rather
   *  than looking like a load that never finished. */
  loaded: boolean
  /** A record landed while this tab was unmounted (the host's poke), so the page
   *  it left is no longer the newest history. Cleared when a load settles; stays
   *  raised while one fails, because the newest records are still unseen. */
  stale: boolean
  /** Generation over `getRuns` dispatches. A reload dispatched later (a poke) has
   *  to be the one that writes, whatever order the answers arrive in — and the
   *  counter lives here because a load can outlive the mount that started it. */
  loadSeq: number
  /** Width (px) the user dragged the list pane to; null = never dragged, so the
   *  pane keeps sizing to its content. This is the session's cache — the
   *  persisted value is the `IStorageService` entry the editor reads on mount. */
  listWidth: number | null
}

function createState(): PerforceSyncHistoryViewState {
  return {
    focusRows: null,
    refresh: null,
    runs: [],
    total: 0,
    hasMore: false,
    selectedId: null,
    limit: SYNC_HISTORY_PAGE_SIZE,
    loaded: false,
    stale: false,
    loadSeq: 0,
    listWidth: null,
  }
}

export const perforceSyncHistoryViewState: PerforceSyncHistoryViewState = createState()

let refreshTimer: ReturnType<typeof setTimeout> | undefined

/**
 * One or more records landed in the extension host. Mounted → reload once, after
 * the merge window; unmounted → mark stale so the next mount reloads exactly
 * once. `stale` is raised SYNCHRONOUSLY: the timer can fire after the tab went
 * away (`refresh` is null by then), and that poke must not be lost.
 */
export function noteSyncHistoryRecorded(): void {
  const state = perforceSyncHistoryViewState
  state.stale = true
  if (state.refresh === null) return
  if (refreshTimer !== undefined) return
  refreshTimer = setTimeout(() => {
    refreshTimer = undefined
    // Re-read at fire time, not at poke time: unmounting nulls `refresh`.
    state.refresh?.()
  }, SYNC_HISTORY_POKE_DEBOUNCE_MS)
}

/** Test-only reset: restore the bucket to a pristine instance and drop any
 *  pending reload, which would otherwise fire into the next test's state. */
export function _resetForTests(): void {
  if (refreshTimer !== undefined) clearTimeout(refreshTimer)
  refreshTimer = undefined
  Object.assign(perforceSyncHistoryViewState, createState())
}
