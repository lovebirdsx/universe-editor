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

import type {
  P4GraphChangeDetailsDto,
  P4GraphFileChangeDto,
  P4GraphLoadResult,
  P4GraphRepoDto,
} from '@universe-editor/extensions-common'

/** Draggable widths (px) of the fixed-width columns. */
export interface PerforceGraphColumnWidths {
  author: number
  date: number
}

export interface PerforceGraphViewState {
  /** Callback registered by the mounted editor to focus the search input. */
  focusSearch: (() => void) | null
  /** Last loaded change list, or null if never loaded. */
  result: P4GraphLoadResult | null
  /** Selected change id (single), or the synthetic pending id. */
  selection: string[]
  /** Cached details for a single-change selection. */
  details: P4GraphChangeDetailsDto | null
  /** Cached file changes for the pending node. */
  pendingFiles: P4GraphFileChangeDto[] | null
  /** Vertical scroll offset of the graph body, restored on remount. */
  scrollTop: number
  /** Vertical scroll offset of the detail panel body, keyed by selection. */
  detailScrollTop: Record<string, number>
  /** Free-text filter over the loaded changes (message / author / id). */
  searchQuery: string
  /** Collapsed directory paths in the detail file tree, keyed by selection. */
  collapsed: Record<string, string[]>
  /** Upper bound on changes to load; raised by "Load more". */
  limit: number
  /** Column widths, adjusted by dragging the header dividers. */
  columnWidths: PerforceGraphColumnWidths
  /** Clients the view can switch between. */
  repos: P4GraphRepoDto[]
  /** Root of the currently targeted client, or null for the default. */
  selectedRepo: string | null
}

/** Page size for the initial load and each "Load more". */
export const PERFORCE_GRAPH_PAGE_SIZE = 300

export const perforceGraphViewState: PerforceGraphViewState = {
  focusSearch: null,
  result: null,
  selection: [],
  details: null,
  pendingFiles: null,
  scrollTop: 0,
  detailScrollTop: {},
  searchQuery: '',
  collapsed: {},
  limit: PERFORCE_GRAPH_PAGE_SIZE,
  columnWidths: {
    author: 140,
    date: 160,
  },
  repos: [],
  selectedRepo: null,
}

/** Stable key for the current selection, used to scope collapse state. */
export function selectionKey(selection: readonly string[]): string {
  return selection.join('..')
}
