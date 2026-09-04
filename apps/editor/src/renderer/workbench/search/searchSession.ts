/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  searchSession — module-level cache of the Search view's transient state.
 *
 *  The SideBar only mounts the active container's view, so switching to Explorer
 *  and back unmounts SearchView and would otherwise drop its query, options and
 *  results. Holding that state here (outside the component, like IScmService does
 *  for SCM) lets a remount restore it instantly. Cached results are tagged with
 *  the workspace they were searched in (resultsWorkspaceKey) so a remount after a
 *  workspace switch re-runs the query instead of showing stale matches.
 *--------------------------------------------------------------------------------------------*/

import type { IFileMatch } from '@universe-editor/platform'

export interface SearchSessionState {
  pattern: string
  replacePattern: string
  includesText: string
  excludesText: string
  isRegex: boolean
  matchCase: boolean
  matchWholeWord: boolean
  replaceVisible: boolean
  filtersVisible: boolean
  results: readonly IFileMatch[]
  /** Workspace folder URI string the cached results belong to; null when searched without a folder. */
  resultsWorkspaceKey: string | null
  /**
   * Nodes the user expanded or collapsed by hand, as a diff against whatever
   * `search.collapseResults` would have chosen. Storing the deviation rather
   * than the raw collapsed set keeps an auto-collapsed file from being mistaken
   * for a deliberate collapse when the setting later changes.
   */
  treeExpansionOverrides: ReadonlyMap<string, boolean>
  /** Resource last opened from the results tree, so a re-focus can target it. */
  lastActivatedResource?: string
  /** The match node id that was focused when that file was opened. */
  lastActivatedFocusId?: string
  /**
   * Set by FindInFilesAction from the active editor's selection. SearchView reads
   * and clears it on mount so opening the panel seeds the query with selected text.
   */
  seedPattern?: string
  /**
   * Set by FindInFolderAction: the `files to include` text to apply. SearchView
   * reads and clears it on mount and on every seed-includes signal, so a mounted
   * view picks it up too. '' is meaningful (folder = workspace root).
   */
  seedIncludes?: string
}

function emptyState(): SearchSessionState {
  return {
    pattern: '',
    replacePattern: '',
    includesText: '',
    excludesText: '',
    isRegex: false,
    matchCase: false,
    matchWholeWord: false,
    replaceVisible: false,
    filtersVisible: false,
    results: [],
    resultsWorkspaceKey: null,
    treeExpansionOverrides: new Map<string, boolean>(),
  }
}

export const searchSession: SearchSessionState = emptyState()

export function resetSearchSession(): void {
  Object.assign(searchSession, emptyState())
  // Optional fields aren't part of emptyState (exactOptionalPropertyTypes), so
  // clear any carried-over value explicitly.
  delete searchSession.lastActivatedResource
  delete searchSession.lastActivatedFocusId
  delete searchSession.seedPattern
  delete searchSession.seedIncludes
}
