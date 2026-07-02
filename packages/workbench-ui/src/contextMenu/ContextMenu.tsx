import { useMemo } from 'react'
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

type RowModel = MenuEntry | MenuSeparator

export function ContextMenu({
  menuId,
  anchor,
  args = [],
  commandService,
  contextKeyService,
  groupFilter,
  onClose,
}: ContextMenuProps) {
  const rows = useMemo<RowModel[]>(() => {
    const entries = MenuRegistry.getMenuItems(menuId, contextKeyService)
    const result: RowModel[] = []
    let prevGroup: string | undefined = undefined

    for (const entry of entries) {
      if (isSubmenuEntry(entry)) continue

      const group = entry.group ?? ''
      if (groupFilter && !groupFilter(group)) continue
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
  }, [menuId, contextKeyService, args, commandService, onClose, groupFilter])

  if (rows.length === 0) return null

  return (
    <AnchoredSurface x={anchor.x} y={anchor.y} onClose={onClose}>
      <ul role="menu" className={styles['menu']}>
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
      </ul>
    </AnchoredSurface>
  )
}
