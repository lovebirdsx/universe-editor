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
  useEffect(() => {
    const onDocClick = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) onClose()
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
      className={styles['overflowMenu']}
      style={{ top: anchor.y, left: anchor.x }}
    >
      {rows.map((row) =>
        row.kind === 'separator' ? (
          row.label ? (
            <li key={row.id} className={styles['overflowSeparatorLabel']}>
              {row.label}
            </li>
          ) : (
            <li key={row.id} role="separator" className={styles['overflowSeparator']} />
          )
        ) : (
          <li
            key={row.id}
            role="menuitem"
            className={styles['overflowItem']}
            tabIndex={-1}
            onClick={() => {
              onClose()
              row.run?.()
            }}
          >
            {(() => {
              const Icon = resolveHeaderIcon(row.icon)
              return Icon ? (
                <Icon size={16} strokeWidth={1.6} />
              ) : (
                <span className={styles['overflowIconGap']} />
              )
            })()}
            <span>{row.label}</span>
          </li>
        ),
      )}
    </ul>,
    document.body,
  )
}
