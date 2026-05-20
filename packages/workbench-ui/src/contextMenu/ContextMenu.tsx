import { useEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import {
  CommandsRegistry,
  type ICommandService,
  type MenuId,
  MenuRegistry,
  isSubmenuEntry,
} from '@universe-editor/platform'
import type { ContextViewAnchor } from '../contextView/IContextViewService.js'
import styles from './ContextMenu.module.css'

export interface ContextMenuProps {
  menuId: MenuId
  anchor: ContextViewAnchor
  /** Passed as the first argument to each executed command. */
  args?: readonly unknown[]
  commandService: ICommandService
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

type RowModel = MenuEntry | MenuSeparator

export function ContextMenu({
  menuId,
  anchor,
  args = [],
  commandService,
  onClose,
}: ContextMenuProps) {
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

  const rows = useMemo<RowModel[]>(() => {
    const entries = MenuRegistry.getMenuItems(menuId)
    const result: RowModel[] = []
    let prevGroup: string | undefined = undefined

    for (const entry of entries) {
      if (isSubmenuEntry(entry)) continue

      const group = entry.group ?? ''
      if (prevGroup !== undefined && prevGroup !== group) {
        result.push({ kind: 'separator', id: `sep-${prevGroup}-${group}` })
      }
      prevGroup = group

      const cmd = CommandsRegistry.getCommand(entry.command)
      const label = entry.title ?? cmd?.metadata?.description ?? entry.command
      const commandId = entry.command
      result.push({
        kind: 'item',
        id: commandId,
        label,
        run: () => {
          onClose()
          void commandService.executeCommand(commandId, ...args)
        },
      })
    }

    return result
  }, [menuId, args, commandService, onClose])

  if (rows.length === 0) return null

  return createPortal(
    <ul ref={ref} role="menu" className={styles['menu']} style={{ top: anchor.y, left: anchor.x }}>
      {rows.map((row) =>
        row.kind === 'separator' ? (
          <li key={row.id} role="separator" className={styles['separator']} />
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
    </ul>,
    document.body,
  )
}
