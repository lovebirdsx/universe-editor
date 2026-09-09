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

import { useEffect, useId, useMemo, type ReactNode } from 'react'
import type { ContextViewAnchor } from '../contextView/IContextViewService.js'
import { AnchoredSurface } from '../overlay/AnchoredSurface.js'
import type { IContextMenuMemory } from './ContextMenu.js'
import type { RowModel } from './menuModel.js'
import { findRowPathById } from './menuModel.js'
import { MenuRows } from './menuRows.js'
import { useMenuNavigation } from './useMenuNavigation.js'

export interface IListMenuItem {
  readonly kind: 'item'
  readonly label: string
  /**
   * Optional id for React keys; defaults to the label + position. Menus that
   * wire up `memory` must pass a stable explicit id per item — the default
   * embeds the row's position, so a remembered id silently stops resolving the
   * moment the item set changes shape.
   */
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
  /**
   * Remembers the last item this menu ran and pre-highlights it the next time
   * the menu is opened *by keyboard* (`autoFocusFirst`) — the `ContextMenu`
   * `memory` prop's counterpart for item-driven menus. Takes effect only when
   * `memoryKey` is also set (it plays the role `MenuId` plays there).
   */
  readonly memory?: IContextMenuMemory | undefined
  /**
   * Identifies this menu in the memory store (e.g. `'keybindings'`). Required
   * for `memory` to take effect; keep it stable and unique across menus.
   */
  readonly memoryKey?: string | undefined
  /**
   * Free-form context discriminator (e.g. the clicked row's shape) so "last
   * executed" is remembered per target rather than globally across the menu.
   * Omitted = one bucket for the whole `memoryKey`.
   */
  readonly contextTag?: string | undefined
  readonly renderIcon?: ((icon: string | undefined) => ReactNode) | undefined
  readonly onClose: () => void
}

function toRows(
  items: readonly ListMenuEntry[],
  onClose: () => void,
  prefix: string,
  recordPicked: ((id: string) => void) | undefined,
): RowModel[] {
  return items.map((entry, index): RowModel => {
    if (entry.kind === 'separator') return { kind: 'separator', id: `${prefix}sep-${index}` }
    const id = entry.id ?? `${prefix}${entry.label}-${index}`
    if (entry.kind === 'submenu') {
      return {
        kind: 'submenu',
        id,
        label: entry.label,
        icon: entry.icon,
        children: toRows(entry.children, onClose, `${id}/`, recordPicked),
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
        // Record before closing so the next keyboard-opened menu restores onto
        // this row (same fire-and-forget + double-write contract as
        // ContextMenu's `memory`).
        recordPicked?.(id)
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
  memory,
  memoryKey,
  contextTag,
  renderIcon,
  onClose,
}: ListMenuProps) {
  const recordPicked = useMemo(() => {
    if (memory === undefined || memoryKey === undefined) return undefined
    return (id: string) => {
      memory.set(memoryKey, contextTag, id)
      if (contextTag !== undefined) memory.set(memoryKey, undefined, id)
    }
  }, [memory, memoryKey, contextTag])
  const rows = useMemo(
    () => toRows(items, onClose, '', recordPicked),
    [items, onClose, recordPicked],
  )
  const uid = useId()
  const hasRows = rows.length > 0
  // Same restore contract as ContextMenu: keyboard-opened menus only, exact
  // contextTag bucket first then the tag-less one, id resolved to a row path
  // (submenu children open expanded with the highlight on the nested row).
  const initialActivePath = useMemo((): readonly number[] | undefined => {
    if (!autoFocusFirst || memory === undefined || memoryKey === undefined) return undefined
    const remembered =
      memory.get(memoryKey, contextTag) ??
      (contextTag === undefined ? undefined : memory.get(memoryKey, undefined))
    if (remembered === undefined) return undefined
    return findRowPathById(rows, remembered)
  }, [autoFocusFirst, memory, memoryKey, contextTag, rows])
  const { state, onRowEnter, onCancelClose, onEscape } = useMenuNavigation(
    rows,
    autoFocusFirst,
    hasRows,
    initialActivePath,
  )

  // An empty menu never opens: report the close so the host drops its state
  // instead of keeping this null-rendering component mounted forever.
  useEffect(() => {
    if (!hasRows) onClose()
  }, [hasRows, onClose])

  if (!hasRows) return null

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
