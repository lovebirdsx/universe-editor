/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SessionChangesViewToolbar — the Session Changes view's title-bar actions,
 *  rendered via viewToolbarMap. A single list/tree toggle (icon flips with the
 *  current mode), mirroring the SCM CHANGES title toolbar. State is shared with
 *  the view body through sessionChangesViewState.
 *--------------------------------------------------------------------------------------------*/

import { FolderTree, List } from 'lucide-react'
import { localize } from '@universe-editor/platform'
import { useObservable } from '../useService.js'
import { sessionChangesViewState } from './sessionChangesViewState.js'
import styles from './SessionChangesViewToolbar.module.css'

export function SessionChangesViewToolbar() {
  const viewMode = useObservable(sessionChangesViewState.viewMode)
  const isTree = viewMode === 'tree'
  return (
    <button
      type="button"
      className={styles['toolbarBtn']}
      data-testid="session-changes-toggle-view-mode"
      title={
        isTree
          ? localize('acp.changes.viewAsList', 'View as List')
          : localize('acp.changes.viewAsTree', 'View as Tree')
      }
      onClick={() => sessionChangesViewState.setViewMode(isTree ? 'list' : 'tree')}
    >
      {isTree ? (
        <List size={14} strokeWidth={1.75} aria-hidden="true" />
      ) : (
        <FolderTree size={14} strokeWidth={1.75} aria-hidden="true" />
      )}
    </button>
  )
}
