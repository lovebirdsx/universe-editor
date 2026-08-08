/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  KeybindingsTable — virtualized grid of keybinding rows, mirroring VSCode's
 *  keybindingsEditor table: fixed 30px header, dynamic row heights driven by
 *  which fields matched (24/40/60, see the VSCode Delegate), single selection,
 *  arrow/home/end/page keyboard navigation, and scroll-position restore.
 *
 *  Action keys (Enter/Delete/Ctrl+C/…) are intentionally NOT handled here —
 *  T8 routes them through Action2 + the editor handle.
 *--------------------------------------------------------------------------------------------*/

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from 'react'
import { localize } from '@universe-editor/platform'
import {
  useScrollRestore,
  VirtualList,
  type VirtualListHandle,
} from '@universe-editor/workbench-ui'
import type { IKeybindingRow } from '../../services/keybindings/keybindingsEditorModel.js'
import type { IKeybindingRowMatch } from '../../services/keybindings/keybindingsSearchModel.js'
import { KeybindingsRow } from './KeybindingsRow.js'
import styles from './KeybindingsEditor.module.css'

const ROW_HEIGHT = 24
const HEADER_HEIGHT = 30

// VSCode keybindingsEditor.ts Delegate: a match on commandId /
// commandDefaultLabel / extensionLabel adds an extra info line (40px);
// commandId + commandDefaultLabel together add both lines (60px).
function estimateRowSize(match: IKeybindingRowMatch): number {
  const { commandId, commandDefaultLabel, extensionLabel } = match.matches
  if (commandId !== undefined && commandDefaultLabel !== undefined) return 60
  if (commandId !== undefined || commandDefaultLabel !== undefined || extensionLabel !== undefined)
    return 40
  return ROW_HEIGHT
}

export interface KeybindingsTableProps {
  readonly rows: readonly IKeybindingRowMatch[]
  readonly selectedRowId: string | undefined
  /** Row to scroll into view + select once it appears (set after a re-key; T7). */
  readonly revealRowId: string | undefined
  /** Row currently in inline when-expression edit mode (T7), if any. */
  readonly whenEditingRowId: string | undefined
  readonly containerRef: RefObject<HTMLDivElement | null>
  readonly onSelect: (rowId: string | undefined) => void
  readonly onRevealed: () => void
  readonly onDefineKeybinding: (row: IKeybindingRow) => void
  readonly onContextMenu: (row: IKeybindingRow, x: number, y: number) => void
  readonly onFocusChange: (focused: boolean) => void
  readonly onWhenCommit: (row: IKeybindingRow, when: string) => void
  readonly onWhenCancel: (viaKeyboard: boolean) => void
  readonly onWhenFocusChange: (focused: boolean) => void
}

export function KeybindingsTable({
  rows,
  selectedRowId,
  revealRowId,
  whenEditingRowId,
  containerRef,
  onSelect,
  onRevealed,
  onDefineKeybinding,
  onContextMenu,
  onFocusChange,
  onWhenCommit,
  onWhenCancel,
  onWhenFocusChange,
}: KeybindingsTableProps) {
  const listRef = useRef<VirtualListHandle>(null)
  useScrollRestore('keybindingsEditor.scroll', () => listRef.current?.getScrollElement() ?? null)

  const selectedIndex =
    selectedRowId === undefined ? -1 : rows.findIndex((m) => m.row.id === selectedRowId)

  const indexOfRowId = useMemo(() => {
    const map = new Map<string, number>()
    rows.forEach((m, i) => map.set(m.row.id, i))
    return map
  }, [rows])

  useEffect(() => {
    if (revealRowId === undefined) return
    const index = indexOfRowId.get(revealRowId)
    if (index === undefined) return
    onSelect(revealRowId)
    listRef.current?.scrollToIndex(index)
    onRevealed()
  }, [revealRowId, indexOfRowId, onSelect, onRevealed])

  const moveSelection = useCallback(
    (next: number) => {
      const row = rows[next]?.row
      if (!row) return
      onSelect(row.id)
      listRef.current?.scrollToIndex(next)
    },
    [rows, onSelect],
  )

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    // Navigation keys belong to the grid itself; a keydown bubbling up from an
    // inner control (the inline when editor's input) is that control's key —
    // VSCode gets the same split via listFocus/whenFocus context gating.
    if (e.target !== e.currentTarget) return
    if (rows.length === 0) return
    const pageSize = Math.max(
      1,
      Math.floor(
        ((listRef.current?.getScrollElement()?.clientHeight ?? 0) || HEADER_HEIGHT * 8) /
          ROW_HEIGHT,
      ),
    )
    const current = selectedIndex < 0 ? 0 : selectedIndex
    let next: number | undefined
    switch (e.key) {
      case 'ArrowDown':
        next = Math.min(current + (selectedIndex < 0 ? 0 : 1), rows.length - 1)
        break
      case 'ArrowUp':
        next = Math.max(current - 1, 0)
        break
      case 'Home':
        next = 0
        break
      case 'End':
        next = rows.length - 1
        break
      case 'PageDown':
        next = Math.min(current + pageSize, rows.length - 1)
        break
      case 'PageUp':
        next = Math.max(current - pageSize, 0)
        break
      default:
        return
    }
    e.preventDefault()
    moveSelection(next)
  }

  const estimateSize = useCallback((index: number) => estimateRowSize(rows[index]!), [rows])
  const getItemKey = useCallback((index: number) => rows[index]?.row.id ?? index, [rows])

  const renderItem = useCallback(
    (match: IKeybindingRowMatch, style: CSSProperties) => {
      const row = match.row
      return (
        <KeybindingsRow
          key={row.id}
          match={match}
          index={indexOfRowId.get(row.id) ?? 0}
          selected={row.id === selectedRowId}
          style={style}
          whenEditing={row.id === whenEditingRowId}
          onSelect={() => onSelect(row.id)}
          onEdit={() => onDefineKeybinding(row)}
          onDefine={() => onDefineKeybinding(row)}
          onContextMenu={(e) => {
            e.preventDefault()
            onSelect(row.id)
            onContextMenu(row, e.clientX, e.clientY)
          }}
          onWhenCommit={(when) => onWhenCommit(row, when)}
          onWhenCancel={onWhenCancel}
          onWhenFocusChange={onWhenFocusChange}
        />
      )
    },
    [
      indexOfRowId,
      selectedRowId,
      whenEditingRowId,
      onSelect,
      onDefineKeybinding,
      onContextMenu,
      onWhenCommit,
      onWhenCancel,
      onWhenFocusChange,
    ],
  )

  return (
    <div
      ref={containerRef}
      role="grid"
      tabIndex={0}
      aria-label={localize('keybindings.table.ariaLabel', 'Keyboard shortcuts')}
      aria-rowcount={rows.length}
      className={styles['table']}
      onKeyDown={onKeyDown}
      onFocus={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onFocusChange(true)
      }}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onFocusChange(false)
      }}
    >
      <div role="row" className={styles['tableHeader']}>
        <span role="columnheader" className={styles['headerCell']} />
        <span role="columnheader" className={styles['headerCell']}>
          {localize('keybindings.column.command', 'Command')}
        </span>
        <span role="columnheader" className={styles['headerCell']}>
          {localize('keybindings.column.keybinding', 'Keybinding')}
        </span>
        <span role="columnheader" className={styles['headerCell']}>
          {localize('keybindings.column.when', 'When')}
        </span>
        <span role="columnheader" className={styles['headerCell']}>
          {localize('keybindings.column.source', 'Source')}
        </span>
      </div>
      <VirtualList
        ref={listRef}
        className={styles['list']}
        items={rows}
        estimateSize={estimateSize}
        getItemKey={getItemKey}
        overscan={8}
        renderItem={renderItem}
      />
    </div>
  )
}
