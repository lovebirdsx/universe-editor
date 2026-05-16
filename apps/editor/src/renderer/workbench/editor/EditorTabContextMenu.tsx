/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  EditorTabContextMenu — portal popup for tab right-click. Items are pulled
 *  from MenuRegistry.getMenuItems(MenuId.EditorTabContext); we only own
 *  positioning, dismissal, and resource argument plumbing.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import {
  CommandsRegistry,
  type ICommandService,
  MenuId,
  MenuRegistry,
  isSubmenuEntry,
  URI,
} from '@universe-editor/platform'
import styles from './EditorArea.module.css'

export interface TabContextMenuState {
  readonly x: number
  readonly y: number
  readonly resource: URI | null
}

interface Props {
  readonly state: TabContextMenuState
  readonly commandService: ICommandService
  readonly onClose: () => void
}

interface MenuItemModel {
  readonly id: string
  readonly label: string
  readonly run: () => void
}

export function EditorTabContextMenu({ state, commandService, onClose }: Props) {
  const ref = useRef<HTMLUListElement>(null)

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const items = useMemo<MenuItemModel[]>(() => {
    const entries = MenuRegistry.getMenuItems(MenuId.EditorTabContext)
    const arg = state.resource ? { resource: state.resource.toJSON() } : undefined
    const out: MenuItemModel[] = []
    for (const entry of entries) {
      if (isSubmenuEntry(entry)) continue
      const cmd = CommandsRegistry.getCommand(entry.command)
      const label = entry.title ?? cmd?.metadata?.description ?? entry.command
      out.push({
        id: entry.command,
        label,
        run: () => {
          onClose()
          void commandService.executeCommand(entry.command, arg)
        },
      })
    }
    return out
  }, [state.resource, commandService, onClose])

  if (items.length === 0) return null

  return createPortal(
    <ul
      ref={ref}
      role="menu"
      className={styles['tabContextMenu']}
      style={{ top: state.y, left: state.x }}
    >
      {items.map((it) => (
        <li key={it.id} role="menuitem" className={styles['tabContextMenuItem']} onClick={it.run}>
          {it.label}
        </li>
      ))}
    </ul>,
    document.body,
  )
}
