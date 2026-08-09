/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Shared title-bar pieces for the changed-files views: tree-mode-only
 *  collapse/expand-all buttons and the `…` overflow menu carrying the
 *  View as List / View as Tree toggle. State flows through the owning view's
 *  module store (callbacks in, observable-derived props down), mirroring
 *  ScmViewToolbar.
 *--------------------------------------------------------------------------------------------*/

import { useMemo, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { localize } from '@universe-editor/platform'
import { resolveHeaderIcon } from '../viewContainerHeader/icon-map.js'
import { ActionButton, TitleOverflowMenu, type OverflowRow } from '../scm/scmShared.js'
import styles from '../scm/ScmView.module.css'
import type { ChangesTreeViewMode } from './buildSnapshot.js'

export function ChangesTreeCollapseExpandButtons({
  viewMode,
  commandPrefix,
  onCollapseAll,
  onExpandAll,
}: {
  readonly viewMode: ChangesTreeViewMode
  /** ActionButton testid stem: scm-title-action-<commandPrefix>.collapseAll */
  readonly commandPrefix: string
  readonly onCollapseAll: () => void
  readonly onExpandAll: () => void
}) {
  if (viewMode !== 'tree') return null
  return (
    <>
      <ActionButton
        action={{
          id: `${commandPrefix}.collapseAll`,
          title: localize('scm.collapseAll', 'Collapse All'),
          command: `${commandPrefix}.collapseAll`,
          icon: 'collapse-all',
        }}
        onRun={onCollapseAll}
      />
      <ActionButton
        action={{
          id: `${commandPrefix}.expandAll`,
          title: localize('scm.expandAll', 'Expand All'),
          command: `${commandPrefix}.expandAll`,
          icon: 'expand-all',
        }}
        onRun={onExpandAll}
      />
    </>
  )
}

export function ChangesTreeViewModeOverflow({
  viewMode,
  onSetViewMode,
}: {
  readonly viewMode: ChangesTreeViewMode
  readonly onSetViewMode: (mode: ChangesTreeViewMode) => void
}) {
  const [overflow, setOverflow] = useState<{ x: number; y: number } | null>(null)

  const overflowRows = useMemo<OverflowRow[]>(
    () => [
      viewMode === 'tree'
        ? {
            kind: 'item',
            id: 'view.list',
            label: localize('scm.viewAsList', 'View as List'),
            icon: 'list-view',
            run: () => onSetViewMode('list'),
          }
        : {
            kind: 'item',
            id: 'view.tree',
            label: localize('scm.viewAsTree', 'View as Tree'),
            icon: 'tree-view',
            run: () => onSetViewMode('tree'),
          },
    ],
    [viewMode, onSetViewMode],
  )

  const openOverflow = (e: ReactMouseEvent): void => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setOverflow({ x: rect.right - 220, y: rect.bottom + 2 })
  }

  return (
    <>
      <button
        type="button"
        className={styles['actionButton']}
        data-tooltip={localize('scm.moreActions', 'More Actions...')}
        aria-label={localize('scm.moreActions', 'More Actions...')}
        onClick={openOverflow}
      >
        {(() => {
          const Icon = resolveHeaderIcon('more')
          return Icon ? <Icon size={16} strokeWidth={1.6} /> : <span>…</span>
        })()}
      </button>
      {overflow && (
        <TitleOverflowMenu
          anchor={overflow}
          rows={overflowRows}
          onClose={() => setOverflow(null)}
        />
      )}
    </>
  )
}
