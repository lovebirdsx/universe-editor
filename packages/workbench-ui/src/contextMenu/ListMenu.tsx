/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ListMenu — a context menu built from an explicit item list rather than from a
 *  MenuId. Views whose entries are computed at open time reach for this one:
 *  Swarm's transitions arrive from an async fetch, a session row disables rename
 *  for foreign worktrees, the keybindings grid puts a shortcut hint on each row —
 *  none of which fit MenuRegistry's static `when`-gated contributions.
 *
 *  It shares its keyboard navigation, virtual focus and submenu machinery with
 *  `ContextMenu` (see `useMenuNavigation` / `MenuRows`), so the two flavours look
 *  and behave identically and cannot drift apart. Picking an item closes the
 *  menu before running it, so a handler that opens a dialog isn't racing a menu
 *  that is still on screen.
 *--------------------------------------------------------------------------------------------*/

import { useId, useMemo, type ReactNode } from 'react'
import type { ContextViewAnchor } from '../contextView/IContextViewService.js'
import { AnchoredSurface } from '../overlay/AnchoredSurface.js'
import type { RowModel } from './menuModel.js'
import { MenuRows } from './menuRows.js'
import { useMenuNavigation } from './useMenuNavigation.js'

export interface IListMenuItem {
  readonly kind: 'item'
  readonly label: string
  /** Optional id for React keys; defaults to the label + position. */
  readonly id?: string | undefined
  readonly icon?: string | undefined
  /** Trailing secondary text, e.g. a keybinding hint. */
  readonly hint?: string | undefined
  /** Rendered in the error colour (delete, discard, obliterate…). */
  readonly danger?: boolean
  /** Visible but inert: dimmed, skipped by arrow keys, no-op on Enter/click. */
  readonly disabled?: boolean
  readonly run: () => void
}

export interface IListMenuSeparator {
  readonly kind: 'separator'
}

export interface IListMenuSubmenu {
  readonly kind: 'submenu'
  readonly label: string
  readonly id?: string | undefined
  readonly icon?: string | undefined
  readonly children: readonly ListMenuEntry[]
}

export type ListMenuEntry = IListMenuItem | IListMenuSeparator | IListMenuSubmenu

export interface ListMenuProps {
  readonly items: readonly ListMenuEntry[]
  readonly anchor: ContextViewAnchor
  /**
   * Highlights the first row on open, so a menu raised with the ContextMenu key
   * is immediately drivable by Enter (VSCode parity). Left off for mouse-opened
   * menus, where an unsolicited highlight reads as a pending action under a
   * pointer that isn't there.
   */
  readonly autoFocusFirst?: boolean
  readonly renderIcon?: ((icon: string | undefined) => ReactNode) | undefined
  readonly onClose: () => void
}

function toRows(items: readonly ListMenuEntry[], onClose: () => void, prefix: string): RowModel[] {
  return items.map((entry, index): RowModel => {
    if (entry.kind === 'separator') return { kind: 'separator', id: `${prefix}sep-${index}` }
    const id = entry.id ?? `${prefix}${entry.label}-${index}`
    if (entry.kind === 'submenu') {
      return {
        kind: 'submenu',
        id,
        label: entry.label,
        icon: entry.icon,
        children: toRows(entry.children, onClose, `${id}/`),
      }
    }
    return {
      kind: 'item',
      id,
      label: entry.label,
      icon: entry.icon,
      hint: entry.hint,
      danger: entry.danger === true,
      disabled: entry.disabled === true,
      run: () => {
        onClose()
        entry.run()
      },
    }
  })
}

export function ListMenu({
  items,
  anchor,
  autoFocusFirst = false,
  renderIcon,
  onClose,
}: ListMenuProps) {
  const rows = useMemo(() => toRows(items, onClose, ''), [items, onClose])
  const uid = useId()
  const { state, onRowEnter, onCancelClose, onEscape } = useMenuNavigation(rows, autoFocusFirst)

  if (rows.length === 0) return null

  return (
    <AnchoredSurface x={anchor.x} y={anchor.y} onClose={onClose} onEscape={onEscape}>
      <MenuRows
        uid={uid}
        rows={rows}
        level={0}
        state={state}
        direction="right"
        onRowEnter={onRowEnter}
        onCancelClose={onCancelClose}
        renderIcon={renderIcon}
      />
    </AnchoredSurface>
  )
}
