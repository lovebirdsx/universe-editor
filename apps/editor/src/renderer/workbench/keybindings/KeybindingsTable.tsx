/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  KeybindingsTable — virtualized grid of keybinding rows, mirroring VSCode's
 *  keybindingsEditor table: fixed 30px header, dynamic row heights driven by
 *  which fields matched (24/40/60, see the VSCode Delegate), single selection,
 *  arrow/home/end/page keyboard navigation, and scroll-position restore.
 *
 *  Navigation comes from the shared `useFlatListNavigation` — the same hook the
 *  session / AI-debug / extensions lists use and the sibling of `Tree`. The grid
 *  only supplies what is genuinely its own: `role="grid"`, rows keyed by
 *  `data-row-id`, and a page size read live off the scroller.
 *
 *  Action keys (Enter/Delete/Ctrl+C/…) are intentionally NOT handled here —
 *  T8 routes them through Action2 + the editor handle, which is why no
 *  `onActivate` is passed: the hook then leaves Enter/Space to bubble.
 *--------------------------------------------------------------------------------------------*/

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type CSSProperties,
  type FocusEvent as ReactFocusEvent,
  type RefObject,
} from 'react'
import { localize } from '@universe-editor/platform'
import {
  isKeyboardContextMenu,
  useFlatListNavigation,
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
  readonly onContextMenu: (row: IKeybindingRow, x: number, y: number, keyboard: boolean) => void
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

  // Prop-driven reveal, deliberately separate from the keyboard cursor: it fires
  // after a re-key, when the row may not exist yet at the time the prop is set.
  useEffect(() => {
    if (revealRowId === undefined) return
    const index = indexOfRowId.get(revealRowId)
    if (index === undefined) return
    onSelect(revealRowId)
    listRef.current?.scrollToIndex(index)
    onRevealed()
  }, [revealRowId, indexOfRowId, onSelect, onRevealed])

  const nav = useFlatListNavigation({
    count: rows.length,
    focusedIndex: selectedIndex,
    onFocusChange: useCallback((index: number) => onSelect(rows[index]?.row.id), [rows, onSelect]),
    getItemKey: useCallback((index: number) => rows[index]?.row.id ?? '', [rows]),
    getContainer: useCallback(() => containerRef.current, [containerRef]),
    role: 'grid',
    // Unlike the other flat lists, focus alone must not select a row: the
    // `keybindingFocus` context key gates the row commands, and arriving in the
    // table is not yet a choice of which binding to act on. VSCode's own
    // keybindings editor does not preselect either.
    focusSelectsFirst: false,
    // The rows carry data-row-id (grid semantics predate the shared hook), so
    // the reveal lookup is pointed at it rather than the default data-row-key.
    rowDataAttr: 'data-row-id',
    ariaLabel: localize('keybindings.table.ariaLabel', 'Keyboard shortcuts'),
    // +1 for the column-header row, which is part of the grid but not of `rows`.
    ariaRowCount: rows.length + 1,
    // Read at keydown time, not memoized: the editor is resizable, and a stale
    // page size makes PageDown jump the wrong distance after a drag.
    getPageSize: useCallback(
      () =>
        Math.max(
          1,
          Math.floor(
            ((listRef.current?.getScrollElement()?.clientHeight ?? 0) || HEADER_HEIGHT * 8) /
              ROW_HEIGHT,
          ),
        ),
      [],
    ),
    scrollToIndex: useCallback((index: number) => listRef.current?.scrollToIndex(index), []),
  })

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
            onContextMenu(row, e.clientX, e.clientY, isKeyboardContextMenu(e))
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
      {...nav.containerProps}
      ref={containerRef}
      className={styles['table']}
      // Containment-checked, unlike the hook's plain focus flag: moving the
      // caret into the inline When editor stays "the table is focused" as far
      // as the keybindingFocus context key is concerned.
      onFocus={(e: ReactFocusEvent<HTMLDivElement>) => {
        nav.containerProps.onFocus()
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) onFocusChange(true)
      }}
      onBlur={(e: ReactFocusEvent<HTMLDivElement>) => {
        nav.containerProps.onBlur()
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
