/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  OutlineViewToolbar — the Outline view's title-bar actions, rendered in the
 *  Secondary Side Bar header via viewToolbarMap. Mirrors VSCode's outline title
 *  actions: a single collapse-all / expand-all toggle (icon flips with the tree
 *  state) and a `…` overflow menu with Follow Cursor / Filter on Type toggles
 *  plus a Sort By radio group. State is shared with the view body through
 *  outlineViewState.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronsDownUp, ChevronsUpDown, MoreHorizontal } from 'lucide-react'
import { localize } from '@universe-editor/platform'
import { useObservable } from '../useService.js'
import { outlineViewState, type OutlineSortOrder } from './outlineViewState.js'
import styles from './OutlineViewToolbar.module.css'

const SORT_OPTIONS: ReadonlyArray<{ id: OutlineSortOrder; label: string }> = [
  { id: 'position', label: localize('outline.sortByPosition', 'Sort By: Position') },
  { id: 'name', label: localize('outline.sortByName', 'Sort By: Name') },
  { id: 'kind', label: localize('outline.sortByKind', 'Sort By: Category') },
]

export function OutlineViewToolbar() {
  const allCollapsed = useObservable(outlineViewState.allCollapsed)
  const followCursor = useObservable(outlineViewState.followCursor)
  const filterOnType = useObservable(outlineViewState.filterOnType)
  const sortBy = useObservable(outlineViewState.sortBy)
  const [overflow, setOverflow] = useState<{ x: number; y: number } | null>(null)

  const openOverflow = (e: ReactMouseEvent): void => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setOverflow({ x: rect.right - 200, y: rect.bottom + 2 })
  }

  return (
    <>
      <button
        type="button"
        className={styles['toolbarBtn']}
        title={
          allCollapsed
            ? localize('outline.expandAll', 'Expand All')
            : localize('outline.collapseAll', 'Collapse All')
        }
        onClick={() =>
          allCollapsed ? outlineViewState.requestExpandAll() : outlineViewState.requestCollapseAll()
        }
      >
        {allCollapsed ? (
          <ChevronsUpDown size={14} strokeWidth={1.75} aria-hidden="true" />
        ) : (
          <ChevronsDownUp size={14} strokeWidth={1.75} aria-hidden="true" />
        )}
      </button>
      <button
        type="button"
        className={styles['toolbarBtn']}
        title={localize('outline.moreActions', 'More Actions...')}
        onClick={openOverflow}
      >
        <MoreHorizontal size={16} strokeWidth={1.6} aria-hidden="true" />
      </button>
      {overflow && (
        <OutlineOverflowMenu
          anchor={overflow}
          followCursor={followCursor}
          filterOnType={filterOnType}
          sortBy={sortBy}
          onClose={() => setOverflow(null)}
        />
      )}
    </>
  )
}

function OutlineOverflowMenu({
  anchor,
  followCursor,
  filterOnType,
  sortBy,
  onClose,
}: {
  anchor: { x: number; y: number }
  followCursor: boolean
  filterOnType: boolean
  sortBy: OutlineSortOrder
  onClose: () => void
}) {
  const ref = useRef<HTMLUListElement>(null)

  useEffect(() => {
    const onDocClick = (e: MouseEvent): void => {
      if ((e.target as Element | null)?.closest('[data-overflow-menu]')) return
      onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  return createPortal(
    <ul
      ref={ref}
      role="menu"
      data-overflow-menu=""
      className={styles['overflowMenu']}
      style={{ top: anchor.y, left: anchor.x }}
    >
      <CheckItem
        label={localize('outline.followCursor', 'Follow Cursor')}
        checked={followCursor}
        onClick={() => outlineViewState.setFollowCursor(!followCursor)}
      />
      <CheckItem
        label={localize('outline.filterOnType', 'Filter on Type')}
        checked={filterOnType}
        onClick={() => outlineViewState.setFilterOnType(!filterOnType)}
      />
      <li role="separator" className={styles['overflowSeparator']} />
      {SORT_OPTIONS.map((opt) => (
        <CheckItem
          key={opt.id}
          label={opt.label}
          checked={sortBy === opt.id}
          onClick={() => outlineViewState.setSortBy(opt.id)}
        />
      ))}
    </ul>,
    document.body,
  )
}

function CheckItem({
  label,
  checked,
  onClick,
}: {
  label: string
  checked: boolean
  onClick: () => void
}) {
  return (
    <li
      role="menuitemcheckbox"
      aria-checked={checked}
      className={styles['overflowItem']}
      tabIndex={-1}
      onClick={onClick}
    >
      <span className={styles['overflowCheck']} aria-hidden="true">
        {checked ? <Check size={14} strokeWidth={2} /> : null}
      </span>
      <span className={styles['overflowItemLabel']}>{label}</span>
    </li>
  )
}
