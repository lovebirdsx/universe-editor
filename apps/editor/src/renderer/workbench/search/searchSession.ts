/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  searchSession — module-level cache of the Search view's transient state.
 *
 *  The SideBar only mounts the active container's view, so switching to Explorer
 *  and back unmounts SearchView and would otherwise drop its query, options and
 *  results. Holding that state here (outside the component, like IScmService does
 *  for SCM) lets a remount restore it instantly. Reset on workspace change.
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
  treeCollapsedIds: ReadonlySet<string>
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
    treeCollapsedIds: new Set<string>(),
  }
}

export const searchSession: SearchSessionState = emptyState()

export function resetSearchSession(): void {
  Object.assign(searchSession, emptyState())
}
