/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  The row model both menu flavours are driven by: `ContextMenu` resolves it from
 *  a `MenuId` through MenuRegistry, `ListMenu` maps it from a caller-built item
 *  list. Everything downstream (keyboard navigation, virtual focus, submenu
 *  panels) only ever sees this shape, so the two flavours cannot drift apart.
 *--------------------------------------------------------------------------------------------*/

export interface MenuEntry {
  kind: 'item'
  id: string
  label: string
  icon: string | undefined
  /** Right-aligned secondary text (a keybinding hint, say). */
  hint?: string | undefined
  /** Shown in the error colour — destructive actions (delete, obliterate, …). */
  danger?: boolean
  /**
   * Rendered dimmed, skipped by arrow navigation and inert to Enter/click.
   * MenuRegistry-driven menus never set it (a failing `when` drops the row
   * outright); item-driven menus need it to keep a row visible-but-inert.
   */
  disabled?: boolean
  run: () => void
}

export interface MenuSeparator {
  kind: 'separator'
  id: string
}

export interface MenuSubmenu {
  kind: 'submenu'
  id: string
  label: string
  icon: string | undefined
  children: RowModel[]
}

export type RowModel = MenuEntry | MenuSeparator | MenuSubmenu

/** A row the keyboard can land on: not a separator, not disabled. */
function isNavigable(row: RowModel | undefined): boolean {
  if (row === undefined || row.kind === 'separator') return false
  return !(row.kind === 'item' && row.disabled === true)
}

/** Rows shown at `level`, walking the open submenu chain. */
export function rowsAtLevel(
  root: readonly RowModel[],
  open: readonly number[],
  level: number,
): readonly RowModel[] | undefined {
  let rows: readonly RowModel[] = root
  for (let k = 0; k < level; k++) {
    const index = open[k]
    if (index === undefined) return undefined
    const row = rows[index]
    if (row?.kind !== 'submenu') return undefined
    rows = row.children
  }
  return rows
}

/** Next navigable row in `delta` direction, wrapping around. */
export function stepIndex(
  rows: readonly RowModel[],
  from: number | undefined,
  delta: 1 | -1,
): number | undefined {
  const count = rows.length
  if (count === 0) return undefined
  let cursor = from ?? (delta === 1 ? -1 : count)
  for (let n = 0; n < count; n++) {
    cursor = (cursor + delta + count) % count
    if (isNavigable(rows[cursor])) return cursor
  }
  return undefined
}

/**
 * Resolve a row id to its index path from the root (length 1 = a top-level
 * row), descending into submenus. Only enabled item rows match — a remembered
 * id that now sits on a disabled or vanished row resolves to `undefined`, so
 * the caller falls back to its default opening highlight. Shared by both menu
 * flavours' "last executed" restore.
 */
export function findRowPathById(
  rows: readonly RowModel[],
  id: string,
): readonly number[] | undefined {
  const findAtLevel = (
    levelRows: readonly RowModel[],
    trail: readonly number[],
  ): readonly number[] | undefined => {
    for (let i = 0; i < levelRows.length; i++) {
      const row = levelRows[i]
      if (row === undefined) continue
      if (row.kind === 'item' && row.id === id && row.disabled !== true) {
        return [...trail, i]
      }
      if (row.kind === 'submenu') {
        const nested = findAtLevel(row.children, [...trail, i])
        if (nested !== undefined) return nested
      }
    }
    return undefined
  }
  return findAtLevel(rows, [])
}
