/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Renderer-side, in-memory view state for the Perforce Graph editor. The editor
 *  component is unmounted whenever its tab is deactivated (only the active editor
 *  renders), which would otherwise discard the loaded changes, selection and
 *  scroll position and force a full reload on every return. This module-level
 *  singleton survives unmount so the view rehydrates instantly.
 *
 *  Mirrors gitGraphViewState (module-level rather than DI, matching the renderer
 *  registries); there is only ever one Perforce Graph editor (fixed resource).
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

export const perforceGraphViewState: PerforceGraphViewState = {
  focusSearch: null,
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
