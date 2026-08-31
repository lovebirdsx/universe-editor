import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  CommandsRegistry,
  type ICommandService,
  type IContextKeyService,
  type MenuId,
  MenuRegistry,
  isSubmenuEntry,
} from '@universe-editor/platform'
import type { ContextViewAnchor } from '../contextView/IContextViewService.js'
import { AnchoredSurface } from '../overlay/AnchoredSurface.js'
import styles from './ContextMenu.module.css'

export interface ContextMenuProps {
  menuId: MenuId
  anchor: ContextViewAnchor
  /** Passed as the first argument to each executed command. */
  args?: readonly unknown[]
  commandService: ICommandService
  /**
   * Overrides how a picked command runs (extension tree views resolve the
   * command host-side so the extension handler gets live objects instead of
   * wire DTOs). When set, `args` is unused.
   */
  executeCommand?: (commandId: string) => void
  contextKeyService?: IContextKeyService
  /**
   * Optional predicate to keep only certain menu groups. Used by the editor
   * title `…` overflow to show everything *except* the primary `navigation`
   * group (which is rendered as inline icon buttons).
   */
  groupFilter?: (group: string) => boolean
  onClose: () => void
}

interface MenuEntry {
  kind: 'item'
  id: string
  label: string
  run: () => void
}

interface MenuSeparator {
  kind: 'separator'
  id: string
}

interface MenuSubmenu {
  kind: 'submenu'
  id: string
  label: string
  children: RowModel[]
}

type RowModel = MenuEntry | MenuSeparator | MenuSubmenu

/** Where an open submenu panel is anchored, in viewport coordinates. */
interface SubmenuState {
  id: string
  rows: RowModel[]
  /** Bounding box of the parent row the panel hangs off. */
  rect: { top: number; left: number; right: number }
}

export function ContextMenu({
  menuId,
  anchor,
  args = [],
  commandService,
  executeCommand,
  contextKeyService,
  groupFilter,
  onClose,
}: ContextMenuProps) {
  const runCommand = useCallback(
    (commandId: string) => {
      onClose()
      if (executeCommand) executeCommand(commandId)
      else void commandService.executeCommand(commandId, ...args)
    },
    [onClose, executeCommand, commandService, args],
  )

  const rows = useMemo<RowModel[]>(() => {
    // `seen` breaks cycles: a submenu contributed into itself (directly or via a
    // longer chain) would otherwise recurse forever.
    const build = (
      id: MenuId,
      seen: ReadonlySet<MenuId>,
      applyGroupFilter: boolean,
    ): RowModel[] => {
      const entries = MenuRegistry.getMenuItems(id, contextKeyService)
      const result: RowModel[] = []
      let prevGroup: string | undefined = undefined

      for (const entry of entries) {
        const group = entry.group ?? ''
        if (applyGroupFilter && groupFilter && !groupFilter(group)) continue

        let row: RowModel
        if (isSubmenuEntry(entry)) {
          if (seen.has(entry.submenu)) continue
          const children = build(entry.submenu, new Set([...seen, entry.submenu]), false)
          // An empty submenu would render as a dead end, so drop the whole row.
          if (children.length === 0) continue
          row = { kind: 'submenu', id: entry.submenu, label: entry.title, children }
        } else {
          const cmd = CommandsRegistry.getCommand(entry.command)
          const commandId = entry.command
          row = {
            kind: 'item',
            id: commandId,
            label: entry.title ?? cmd?.metadata?.description ?? commandId,
            run: () => runCommand(commandId),
          }
        }

        if (prevGroup !== undefined && prevGroup !== group) {
          result.push({ kind: 'separator', id: `sep-${prevGroup}-${group}` })
        }
        prevGroup = group
        result.push(row)
      }

      return result
    }

    return build(menuId, new Set([menuId]), true)
  }, [menuId, contextKeyService, groupFilter, runCommand])

  const [openSub, setOpenSub] = useState<SubmenuState | null>(null)

  if (rows.length === 0) return null

  return (
    <AnchoredSurface x={anchor.x} y={anchor.y} onClose={onClose}>
      <ul role="menu" className={styles['menu']}>
        {rows.map((row) => {
          if (row.kind === 'separator') {
            return <li key={row.id} role="separator" className={styles['separator']} />
          }
          if (row.kind === 'submenu') {
            return (
              <li
                key={row.id}
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={openSub?.id === row.id}
                className={`${styles['item']} ${styles['submenuItem']}`}
                tabIndex={-1}
                onMouseEnter={(e) => {
                  const r = e.currentTarget.getBoundingClientRect()
                  setOpenSub({
                    id: row.id,
                    rows: row.children,
                    rect: { top: r.top, left: r.left, right: r.right },
                  })
                }}
              >
                {row.label}
              </li>
            )
          }
          return (
            <li
              key={row.id}
              role="menuitem"
              className={styles['item']}
              tabIndex={-1}
              onMouseEnter={() => setOpenSub(null)}
              onClick={row.run}
            >
              {row.label}
            </li>
          )
        })}
      </ul>
      {/*
        The panel is a sibling of `.menu` (which scrolls, and would clip an
        absolutely positioned child) but still inside the anchored surface's
        floating element: Floating UI's dismiss-on-outside-press only ignores
        presses within that element, so a panel portalled elsewhere would close
        the whole menu on mousedown and swallow the click.
      */}
      {openSub && <SubmenuPanel key={openSub.id} rows={openSub.rows} rect={openSub.rect} />}
    </AnchoredSurface>
  )
}

function SubmenuPanel({ rows, rect }: { rows: RowModel[]; rect: SubmenuState['rect'] }) {
  const ref = useRef<HTMLUListElement>(null)
  // Start off-screen so the pre-measurement frame isn't visible.
  const [pos, setPos] = useState<{ top: number; left: number } | undefined>(undefined)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    const margin = 8
    // Prefer opening to the right of the parent row; fall back to its left when
    // that would run off-screen, then clamp both axes into the viewport.
    let left = rect.right
    if (left + width > window.innerWidth - margin) left = rect.left - width
    left = Math.max(margin, Math.min(left, window.innerWidth - width - margin))
    const top = Math.max(margin, Math.min(rect.top, window.innerHeight - height - margin))
    setPos({ top, left })
  }, [rect])

  return (
    <ul
      ref={ref}
      role="menu"
      className={`${styles['menu']} ${styles['submenu']}`}
      style={pos ? { top: pos.top, left: pos.left } : { top: 0, left: -9999 }}
    >
      {rows.map((row) =>
        row.kind === 'separator' ? (
          <li key={row.id} role="separator" className={styles['separator']} />
        ) : row.kind === 'submenu' ? (
          <li
            key={row.id}
            role="menuitem"
            aria-haspopup="menu"
            className={`${styles['item']} ${styles['submenuItem']}`}
            tabIndex={-1}
          >
            {row.label}
          </li>
        ) : (
          <li
            key={row.id}
            role="menuitem"
            className={styles['item']}
            tabIndex={-1}
            onClick={row.run}
          >
            {row.label}
          </li>
        ),
      )}
    </ul>
  )
}
