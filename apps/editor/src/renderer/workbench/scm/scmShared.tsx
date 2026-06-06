/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Shared SCM building blocks reused by ScmView (body) and ScmViewToolbar
 *  (title bar): menu resolution, the icon ActionButton, and the title overflow
 *  menu. Kept here so the toolbar — which renders in the view's title bar, a
 *  separate React subtree from the body — doesn't duplicate them.
 *--------------------------------------------------------------------------------------------*/

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import { createPortal } from 'react-dom'
import {
  CommandsRegistry,
  ContextKeyExpr,
  isSubmenuEntry,
  MenuId,
  MenuRegistry,
  type ContextKeyExpression,
  type IContext,
} from '@universe-editor/platform'
import { resolveHeaderIcon } from '../viewContainerHeader/icon-map.js'
import styles from './ScmView.module.css'

export type ViewMode = 'list' | 'tree'

export interface ActionItem {
  readonly id: string
  readonly title: string
  readonly command: string
  readonly icon?: string | undefined
  readonly group?: string | undefined
}

export function evalWhen(
  when: string | ContextKeyExpression | undefined,
  scope: Record<string, unknown>,
): boolean {
  if (!when) return true
  const expr = typeof when === 'string' ? ContextKeyExpr.deserialize(when) : when
  if (!expr) return true
  return expr.evaluate({ getValue: (key: string) => scope[key] } as IContext)
}

/** Re-render trigger that fires whenever any menu contribution changes. */
export function useMenuRevision(): number {
  const [rev, setRev] = useState(0)
  useLayoutEffect(() => {
    const d = MenuRegistry.onDidChangeMenu(() => setRev((v) => v + 1))
    return () => d.dispose()
  }, [])
  return rev
}

/** Menu items for a location filtered by `when`, resolved to ActionItems. */
export function menuActions(
  menuId: MenuId,
  scope: Record<string, unknown>,
  group?: string,
): ActionItem[] {
  const out: ActionItem[] = []
  for (const entry of MenuRegistry.getMenuItems(menuId)) {
    if (isSubmenuEntry(entry)) continue
    if (group !== undefined && entry.group !== group) continue
    if (!evalWhen(entry.when, scope)) continue
    const cmd = CommandsRegistry.getCommand(entry.command)
    out.push({
      id: entry.command,
      title: entry.title ?? cmd?.metadata?.description ?? entry.command,
      command: entry.command,
      icon: entry.icon,
      group: entry.group,
    })
  }
  return out
}

/** Icon button that falls back to its title text when no icon is mapped. */
export function ActionButton({
  action,
  onRun,
}: {
  action: ActionItem
  onRun: (e: ReactMouseEvent) => void
}) {
  const Icon = resolveHeaderIcon(action.icon)
  return (
    <button type="button" className={styles['actionButton']} title={action.title} onClick={onRun}>
      {Icon ? <Icon size={16} strokeWidth={1.6} /> : <span>{action.title}</span>}
    </button>
  )
}

export type OverflowRow =
  | { kind: 'separator'; id: string; label?: string }
  | { kind: 'item'; id: string; label?: string; icon?: string | undefined; run?: () => void }
  | {
      kind: 'submenu'
      id: string
      label?: string
      icon?: string | undefined
      children: OverflowRow[]
    }

/**
 * Resolve a MenuId into renderable overflow rows, recursing into submenu
 * contributions. `navigation` items are skipped (they live inline in the
 * toolbar). Group changes insert a separator so VSCode-style sections stay
 * visually distinct.
 */
export function menuToRows(
  menuId: MenuId,
  scope: Record<string, unknown>,
  runCommand: (command: string) => void,
): OverflowRow[] {
  const rows: OverflowRow[] = []
  let prevGroup: string | undefined
  let started = false
  for (const entry of MenuRegistry.getMenuItems(menuId)) {
    if (entry.group === 'navigation') continue
    if (!evalWhen(entry.when, scope)) continue
    if (started && entry.group !== prevGroup) {
      rows.push({ kind: 'separator', id: `sep-${prevGroup ?? ''}-${entry.group ?? ''}` })
    }
    prevGroup = entry.group
    started = true
    if (isSubmenuEntry(entry)) {
      rows.push({
        kind: 'submenu',
        id: entry.submenu,
        label: entry.title,
        icon: entry.icon,
        children: menuToRows(entry.submenu, scope, runCommand),
      })
    } else {
      const cmd = CommandsRegistry.getCommand(entry.command)
      rows.push({
        kind: 'item',
        id: entry.command,
        label: entry.title ?? cmd?.metadata?.description ?? entry.command,
        icon: entry.icon,
        run: () => runCommand(entry.command),
      })
    }
  }
  return rows
}

export function TitleOverflowMenu({
  anchor,
  rows,
  onClose,
}: {
  anchor: { x: number; y: number }
  rows: OverflowRow[]
  onClose: () => void
}) {
  const ref = useRef<HTMLUListElement>(null)
  const [openSub, setOpenSub] = useState<{
    id: string
    anchor: { x: number; y: number }
    rows: OverflowRow[]
  } | null>(null)

  useEffect(() => {
    const onDocClick = (e: MouseEvent): void => {
      // Ignore clicks inside any level of the (portalled) menu stack.
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
    <>
      <ul
        ref={ref}
        role="menu"
        data-overflow-menu=""
        className={styles['overflowMenu']}
        style={{ top: anchor.y, left: anchor.x }}
      >
        {rows.map((row) => {
          if (row.kind === 'separator') {
            return row.label ? (
              <li key={row.id} className={styles['overflowSeparatorLabel']}>
                {row.label}
              </li>
            ) : (
              <li key={row.id} role="separator" className={styles['overflowSeparator']} />
            )
          }
          const Icon = resolveHeaderIcon(row.icon)
          const iconEl = Icon ? (
            <Icon size={16} strokeWidth={1.6} />
          ) : (
            <span className={styles['overflowIconGap']} />
          )
          if (row.kind === 'submenu') {
            return (
              <li
                key={row.id}
                role="menuitem"
                className={styles['overflowItem']}
                tabIndex={-1}
                onMouseEnter={(e) => {
                  const r = e.currentTarget.getBoundingClientRect()
                  setOpenSub({
                    id: row.id,
                    anchor: { x: r.right - 4, y: r.top - 4 },
                    rows: row.children,
                  })
                }}
              >
                {iconEl}
                <span className={styles['overflowItemLabel']}>{row.label}</span>
                <span className={styles['overflowSubmenuArrow']}>▸</span>
              </li>
            )
          }
          return (
            <li
              key={row.id}
              role="menuitem"
              className={styles['overflowItem']}
              tabIndex={-1}
              onMouseEnter={() => setOpenSub(null)}
              onClick={() => {
                onClose()
                row.run?.()
              }}
            >
              {iconEl}
              <span className={styles['overflowItemLabel']}>{row.label}</span>
            </li>
          )
        })}
      </ul>
      {openSub && (
        <TitleOverflowMenu anchor={openSub.anchor} rows={openSub.rows} onClose={onClose} />
      )}
    </>,
    document.body,
  )
}
