/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SearchViewToolbar — the Search view's title-bar actions, rendered in the
 *  SideBar header (single-view container) via viewToolbarMap. Mirrors VSCode's
 *  search title actions: refresh, clear results, collapse all, and a list/tree
 *  view-mode toggle. State is shared with the view body through searchViewState.
 *--------------------------------------------------------------------------------------------*/

import { ChevronsDownUp, List, ListTree, RefreshCw, SearchX } from 'lucide-react'
import { localize } from '@universe-editor/platform'
import { useObservable } from '../useService.js'
import { searchViewState } from './searchViewState.js'
import styles from './SearchView.module.css'

export function SearchViewToolbar() {
  const hasResults = useObservable(searchViewState.hasResults)
  const viewMode = useObservable(searchViewState.viewMode)
  const isTree = viewMode === 'tree'

  return (
    <>
      <button
        type="button"
        className={styles['toolbarBtn']}
        title={localize('search.refresh', 'Refresh')}
        disabled={!hasResults}
        onClick={() => searchViewState.requestRefresh()}
      >
        <RefreshCw size={14} strokeWidth={1.75} aria-hidden="true" />
      </button>
      <button
        type="button"
        className={styles['toolbarBtn']}
        title={localize('search.clear', 'Clear Search Results')}
        disabled={!hasResults}
        onClick={() => searchViewState.requestClear()}
      >
        <SearchX size={14} strokeWidth={1.75} aria-hidden="true" />
      </button>
      <button
        type="button"
        className={styles['toolbarBtn']}
        title={localize('search.collapseAll', 'Collapse All')}
        disabled={!hasResults}
        onClick={() => searchViewState.requestCollapseAll()}
      >
        <ChevronsDownUp size={14} strokeWidth={1.75} aria-hidden="true" />
      </button>
      <button
        type="button"
        className={styles['toolbarBtn']}
        title={
          isTree
            ? localize('search.viewAsList', 'View as List')
            : localize('search.viewAsTree', 'View as Tree')
        }
        aria-pressed={isTree}
        onClick={() => searchViewState.setViewMode(isTree ? 'list' : 'tree')}
      >
        {isTree ? (
          <List size={14} strokeWidth={1.75} aria-hidden="true" />
        ) : (
          <ListTree size={14} strokeWidth={1.75} aria-hidden="true" />
        )}
      </button>
    </>
  )
}
