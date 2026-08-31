/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Renderer-side, in-memory view state for the Perforce Graph editor. The editor
 *  component is unmounted whenever its tab is deactivated (only the active editor
 *  renders), which would otherwise discard the loaded changes, selection and
 *  scroll position and force a full reload on every return. The per-input store
 *  survives unmount so the view rehydrates instantly.
 *
 *  Mirrors gitGraphViewState (module-level rather than DI, matching the renderer
 *  registries). Perforce Graph can now be opened scoped to a path (multiple
 *  tabs), so state is bucketed by input id: the GLOBAL bucket backs the classic
 *  unscoped tab, and each scoped tab gets its own bucket. Scoped buckets are
 *  bounded (MAX_SCOPED_STATES) because each one holds the full change array for
 *  a page — unbounded growth over a long session would eat memory (the renderer
 *  has OOM'd on unbounded session state before).
 *--------------------------------------------------------------------------------------------*/

import { observableValue, type ISettableObservable } from '@universe-editor/platform'
import type { P4GraphLoadResult, P4GraphRepoDto } from '@universe-editor/extensions-common'

/** Draggable widths (px) of the fixed-width columns. */
export interface PerforceGraphColumnWidths {
  author: number
  date: number
}

export interface PerforceGraphViewState {
  /** Callback registered by the mounted editor to focus the search input. */
  focusSearch: (() => void) | null
  /** Callback registered by the mounted editor to focus the row list, used by
   *  PerforceGraphEditorInput.focus() so opening/activating the tab lands
   *  keyboard focus on the changes (arrow keys work without a prior click). */
  focusRows: (() => void) | null
  /** Callback registered by the mounted editor to reload the graph (toolbar ↺). */
  refresh: (() => void) | null
  /** Callback registered by the mounted editor to select + scroll to a change,
   *  paging in more history until the change is loaded. */
  revealCommit: ((id: string) => void) | null
  /** Change to reveal, consumed reactively by the mounted editor. Observable
   *  for the same reason as gitGraphViewState.pendingReveal: a reveal issued
   *  alongside the tab switch must reach the newly mounted instance. */
  pendingReveal: ISettableObservable<string | null>
  /** Last loaded change list, or null if never loaded. */
  result: P4GraphLoadResult | null
  /** Selected change id (single), or the synthetic pending id. */
  selection: string[]
  /** Vertical scroll offset of the graph body, restored on remount. */
  scrollTop: number
  /** Free-text filter over the loaded changes (message / author / id). */
  searchQuery: string
  /** Upper bound on changes to load; raised by "Load more". */
  limit: number
  /** Column widths, adjusted by dragging the header dividers. */
  columnWidths: PerforceGraphColumnWidths
  /** Clients the view can switch between. */
  repos: P4GraphRepoDto[]
  /** Root of the currently targeted client, or null for the default. */
  selectedRepo: string | null
  /** Whether to list changes across the whole client depot instead of only the
   *  opened workspace folder. Persisted per-workspace; see the editor. */
  wholeRepo: boolean
}

/** Page size for the initial load and each "Load more". */
export const PERFORCE_GRAPH_PAGE_SIZE = 300

/** Key of the unscoped graph bucket — the input whose resource is the plain
 *  `universe:/perforceGraph` URI. Never evicted. */
export const GLOBAL_PERFORCE_GRAPH_KEY = 'universe:/perforceGraph'

/** Upper bound on scoped buckets. Each bucket holds the full change array for
 *  its page, so keeping every scoped tab alive forever grows without bound over
 *  a long session and pressures memory. The GLOBAL bucket is exempt — it is the
 *  one the timeline / blame reveal bridge always writes to. */
const MAX_SCOPED_STATES = 12

function createPerforceGraphViewState(): PerforceGraphViewState {
  return {
    focusSearch: null,
    focusRows: null,
    refresh: null,
    revealCommit: null,
    pendingReveal: observableValue<string | null>('perforceGraph.pendingReveal', null),
    result: null,
    selection: [],
    scrollTop: 0,
    searchQuery: '',
    limit: PERFORCE_GRAPH_PAGE_SIZE,
    columnWidths: {
      author: 140,
      date: 160,
    },
    repos: [],
    selectedRepo: null,
    wholeRepo: false,
  }
}

/** Lazily-built scoped buckets keyed by input id. `Map` iteration order doubles
 *  as the LRU order: re-accessing a bucket re-inserts it at the back, and
 *  eviction removes from the front (least-recently accessed). */
const _scopedStates = new Map<string, PerforceGraphViewState>()

/** The unscoped bucket, always present and never evicted. */
const _globalState = createPerforceGraphViewState()

export function getPerforceGraphViewState(key: string): PerforceGraphViewState {
  if (key === GLOBAL_PERFORCE_GRAPH_KEY) return _globalState
  const existing = _scopedStates.get(key)
  if (existing) {
    // Refresh recency: re-insert at the back so the least-recently-accessed
    // bucket stays at the front for eviction.
    _scopedStates.delete(key)
    _scopedStates.set(key, existing)
    return existing
  }
  const state = createPerforceGraphViewState()
  _scopedStates.set(key, state)
  while (_scopedStates.size > MAX_SCOPED_STATES) {
    const oldest = _scopedStates.keys().next().value
    if (oldest === undefined) break
    _scopedStates.delete(oldest)
  }
  return state
}

/** Backwards-compatible singleton for the classic unscoped graph. The timeline
 *  / blame reveal bridge (OpenPerforceGraphFromExtensionAction) and existing
 *  tests keep using it directly. */
export const perforceGraphViewState = getPerforceGraphViewState(GLOBAL_PERFORCE_GRAPH_KEY)

/** Test-only reset: drop every scoped bucket and restore the global bucket to a
 *  pristine instance. */
export function _resetForTests(): void {
  _scopedStates.clear()
  Object.assign(_globalState, createPerforceGraphViewState())
}
