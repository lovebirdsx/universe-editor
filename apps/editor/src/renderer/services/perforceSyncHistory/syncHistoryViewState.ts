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

export interface PerforceSyncHistoryViewState {
  /** Callback registered by the mounted editor to focus the row list, used by
   *  `PerforceSyncHistoryEditorInput.focus()` so opening or activating the tab
   *  lands keyboard focus on the runs (arrow keys work without a prior click). */
  focusRows: (() => void) | null
  /** Callback registered by the mounted editor to reload the page (toolbar ↺). */
  refresh: (() => void) | null
  /** The loaded page, newest first. Empty until the first load settles. */
  runs: P4SyncRunDto[]
  /** Matching runs in total, as the extension counted them (not `runs.length`). */
  total: number
  hasMore: boolean
  /** Selected run id, or null before the first selection. */
  selectedId: string | null
  /** Page size in force; "Load more" raises it by one page. */
  limit: number
  /** True once a load has settled, so an empty list can say "none yet" rather
   *  than looking like a load that never finished. */
  loaded: boolean
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
  }
}

export const perforceSyncHistoryViewState: PerforceSyncHistoryViewState = createState()

/** Test-only reset: restore the bucket to a pristine instance. */
export function _resetForTests(): void {
  Object.assign(perforceSyncHistoryViewState, createState())
}
