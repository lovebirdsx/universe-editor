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
import { findRowPathById } from './menuModel.js'
import { MenuRows } from './menuRows.js'
import { useMenuNavigation } from './useMenuNavigation.js'

/**
 * Sync, in-memory view of "the last item this menu ran, per context tag".
 * Implementations bridge to whatever persistence they like (the editor caches
 * `IStorageService` in memory and writes through in the background) — reads
 * must be synchronous because the opening highlight is chosen in a `useState`
 * initializer with no room for a round-trip.
 *
 * `scope` identifies the menu: `ContextMenu` passes its `MenuId` string,
 * `ListMenu` passes its caller-supplied `memoryKey`. Lookup is two-level: the
 * menu first asks for `scope + contextTag`, then falls back to
 * `scope + undefined` (the tag-less bucket). For the fallback to ever hit,
 * implementations should therefore also record each pick under `undefined` —
 * see the `memory` prop on `ContextMenu`/`ListMenu`.
 */
export interface IContextMenuMemory {
  get(scope: string, contextTag: string | undefined): string | undefined
  set(scope: string, contextTag: string | undefined, itemId: string): void
}

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
  /**
   * Remembers the last command this menu ran and pre-highlights it the next
   * time the menu is opened *by keyboard* (`autoFocusFirst`). Omit to keep the
   * "first row" default. Mouse-opened menus are unaffected: with no opening
   * highlight there is nothing to restore into.
   *
   * Lookup is per `menuId + contextTag`, falling back to the tag-less
   * `menuId` bucket when the exact tag was never recorded — so e.g. picking
   * "Copy Name" on a file lets the *directory* menu (never used before) open
   * on "Copy Name" too, as long as that command exists there. Every pick is
   * therefore recorded twice: under its `contextTag` and under `undefined`.
   */
  memory?: IContextMenuMemory
  /**
   * Free-form context discriminator supplied by the host (e.g. Explorer's
   * `'file' | 'directory' | 'root'`) so "last executed" is remembered per
   * target shape rather than globally across the menu. Omitted = one bucket
   * for the whole `menuId`.
   */
  contextTag?: string
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
  memory,
  contextTag,
  onClose,
}: ContextMenuProps) {
  const runCommand = useCallback(
    (commandId: string) => {
      // Record before closing so the *next* keyboard-opened menu can restore
      // onto this row. Fire-and-forget: the command's success is unknown and
      // irrelevant — the user picked it, that is the signal. Double-write:
      // the tag-less bucket powers the cross-tag fallback (see `memory`).
      memory?.set(String(menuId), contextTag, commandId)
      if (contextTag !== undefined) memory?.set(String(menuId), undefined, commandId)
      onClose()
      if (executeCommand) executeCommand(commandId)
      else void commandService.executeCommand(commandId, ...args)
    },
    [onClose, executeCommand, commandService, args, memory, menuId, contextTag],
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
  // Resolve the remembered command id to a row *path* while we still see the
  // rows — the navigation hook itself stays id-agnostic. Only consulted for
  // keyboard-opened menus: mouse-opened ones have no opening highlight to
  // override, and looking the store up would be wasted work. Lookup tries the
  // exact `contextTag` bucket first, then the tag-less `menuId` bucket; the
  // existence check baked into the path walk is what makes the fallback safe —
  // a command remembered from a *different* target shape (say "Copy Name" on a
  // file) only wins here if the current menu actually offers it, otherwise the
  // open silently falls back to the first row. The path runs from the root all
  // the way down to a nested command's own row, so a remembered submenu child
  // opens with every panel expanded and the highlight on the command itself —
  // Enter runs it straight away.
  const initialActivePath = useMemo((): readonly number[] | undefined => {
    if (!autoFocusFirst || memory === undefined) return undefined
    const scope = String(menuId)
    const remembered =
      memory.get(scope, contextTag) ??
      (contextTag === undefined ? undefined : memory.get(scope, undefined))
    if (remembered === undefined) return undefined
    return findRowPathById(rows, remembered)
  }, [autoFocusFirst, memory, menuId, contextTag, rows])
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
