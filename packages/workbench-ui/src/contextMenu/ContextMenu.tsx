import { useCallback, useEffect, useId, useMemo, type ReactNode } from 'react'
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
import type { RowModel } from './menuModel.js'
import { MenuRows } from './menuRows.js'
import { useMenuNavigation } from './useMenuNavigation.js'

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
  /**
   * Renders the leading icon slot for a row from a menu contribution's `icon`
   * id. Icons stay a caller concern (this package takes no icon library), and
   * when set every row gets a fixed-width slot — including rows without an icon
   * — so labels stay aligned. Omit it for icon-less menus (Explorer, VSCode
   * parity), which then render no slot at all.
   */
  renderIcon?: (icon: string | undefined) => ReactNode
  /**
   * Highlights the first row on open, so a menu the user raised with the
   * ContextMenu key is immediately drivable by Enter (VSCode parity). Left off
   * for mouse-opened menus, where an unsolicited highlight reads as a pending
   * action under a pointer that isn't there.
   */
  autoFocusFirst?: boolean
  onClose: () => void
}

/**
 * Stable stand-in for an omitted `args`. A `= []` default would mint a fresh
 * array on every render, invalidating `runCommand` and through it the `rows`
 * memo — so every keystroke would re-resolve the menu against a context service
 * the caller may since have disposed, and the menu would vanish mid-navigation.
 */
const NO_ARGS: readonly unknown[] = []

export function ContextMenu({
  menuId,
  anchor,
  args = NO_ARGS,
  commandService,
  executeCommand,
  contextKeyService,
  groupFilter,
  renderIcon,
  autoFocusFirst = false,
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
          row = {
            kind: 'submenu',
            id: entry.submenu,
            label: entry.title,
            icon: entry.icon,
            children,
          }
        } else {
          const cmd = CommandsRegistry.getCommand(entry.command)
          const commandId = entry.command
          row = {
            kind: 'item',
            id: commandId,
            label: entry.title ?? cmd?.metadata?.description ?? commandId,
            icon: entry.icon,
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

  const uid = useId()
  const hasRows = rows.length > 0
  const { state, onRowEnter, onCancelClose, onEscape } = useMenuNavigation(
    rows,
    autoFocusFirst,
    hasRows,
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
