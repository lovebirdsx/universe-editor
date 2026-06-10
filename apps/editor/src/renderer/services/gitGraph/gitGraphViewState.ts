/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Renderer-side, in-memory view state for the Git Graph editor. The editor
 *  component is unmounted whenever its tab is deactivated (only the active
 *  editor renders), which would otherwise discard the loaded commits, selection
 *  and scroll position and force a full reload on every return. This module-level
 *  singleton survives unmount so the view rehydrates instantly.
 *
 *  Module-level (rather than DI) mirrors the existing renderer registries
 *  (`editorComponentMap`, `EditorRegistry`); there is only ever one Git Graph
 *  editor (its resource is fixed), so a single store object suffices.
 *--------------------------------------------------------------------------------------------*/

import type {
  GitGraphCommitDetailsDto,
  GitGraphFileChangeDto,
  GitGraphLoadResult,
  GitGraphRepoDto,
} from '@universe-editor/extensions-common'

/** User-tunable view options, surfaced through the settings popover. */
export interface GitGraphSettings {
  /** Commit ordering passed to `git log`. */
  order: 'date' | 'author-date' | 'topo'
  /** Include remote-tracking branches as graph roots. */
  includeRemotes: boolean
  /** Draw only first-parent lines (collapses merged-in branch lanes). */
  onlyFollowFirstParent: boolean
}

/** Draggable widths (px) of the fixed-width columns. */
export interface GitGraphColumnWidths {
  author: number
  date: number
}

export interface GitGraphViewState {
  /** Callback registered by the mounted editor to focus the search input. */
  focusSearch: (() => void) | null
  /** Callback registered by the mounted editor to toggle remote-branch visibility. */
  toggleRemoteBranches: (() => void) | null
  /** Last loaded commit list, or null if never loaded. */
  result: GitGraphLoadResult | null
  /** Selected commit hash(es): one to expand details, two to compare. */
  selection: string[]
  /** Cached details for a single-commit selection. */
  details: GitGraphCommitDetailsDto | null
  /** Cached file changes for a two-commit comparison. */
  compareFiles: GitGraphFileChangeDto[] | null
  /** Vertical scroll offset of the graph body, restored on remount. */
  scrollTop: number
  /** Vertical scroll offset of the detail panel body, keyed by selection. */
  detailScrollTop: Record<string, number>
  /** Free-text filter over the loaded commits (message / author / hash). */
  searchQuery: string
  /** Collapsed directory paths in the detail file tree, keyed by selection. */
  collapsed: Record<string, string[]>
  /** View options (order / remotes / first-parent). */
  settings: GitGraphSettings
  /** Upper bound on commits to load; raised by "Load more". */
  limit: number
  /** Column widths, adjusted by dragging the header dividers. */
  columnWidths: GitGraphColumnWidths
  /** Repositories the view can switch between (main repo + submodules). */
  repos: GitGraphRepoDto[]
  /** Root of the currently targeted repository, or null for the default. */
  selectedRepo: string | null
}

/** Page size for the initial load and each "Load more". */
export const GIT_GRAPH_PAGE_SIZE = 500

export const gitGraphViewState: GitGraphViewState = {
  focusSearch: null,
  toggleRemoteBranches: null,
  result: null,
  selection: [],
  details: null,
  compareFiles: null,
  scrollTop: 0,
  detailScrollTop: {},
  searchQuery: '',
  collapsed: {},
  settings: {
    order: 'date',
    includeRemotes: true,
    onlyFollowFirstParent: false,
  },
  limit: GIT_GRAPH_PAGE_SIZE,
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
