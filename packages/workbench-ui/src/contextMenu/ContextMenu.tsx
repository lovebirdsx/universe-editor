import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
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
import {
  computeSubmenuPosition,
  type IViewportSize,
  type SubmenuDirection,
} from '../overlay/anchorLayout.js'
import { useTransformFreePlacement } from '../overlay/useTransformFreePlacement.js'
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

/**
 * Hovering a sibling row does not tear the open panel down straight away: a
 * diagonal sweep from the parent row into its panel passes over siblings, and
 * closing on the first of those would make the panel unreachable by mouse.
 */
const SUBMENU_CLOSE_DELAY_MS = 250

/** The row the keyboard acts on, addressed by its depth and index. */
interface MenuActive {
  readonly level: number
  readonly index: number
}

interface MenuState {
  /** Index of the expanded submenu row at each open level, root-first. */
  readonly open: readonly number[]
  readonly active: MenuActive | undefined
}

const INITIAL_STATE: MenuState = { open: [], active: undefined }

/** Rows shown at `level`, walking the open submenu chain. */
function rowsAtLevel(
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

/** Next non-separator row in `delta` direction, wrapping around. */
function stepIndex(
  rows: readonly RowModel[],
  from: number | undefined,
  delta: 1 | -1,
): number | undefined {
  const count = rows.length
  if (count === 0) return undefined
  let cursor = from ?? (delta === 1 ? -1 : count)
  for (let n = 0; n < count; n++) {
    cursor = (cursor + delta + count) % count
    if (rows[cursor]?.kind !== 'separator') return cursor
  }
  return undefined
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

  const uid = useId()
  const [state, setState] = useState<MenuState>(INITIAL_STATE)
  const stateRef = useRef(state)
  stateRef.current = state
  const rowsRef = useRef(rows)
  rowsRef.current = rows
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const cancelClose = useCallback(() => {
    if (closeTimer.current !== undefined) {
      clearTimeout(closeTimer.current)
      closeTimer.current = undefined
    }
  }, [])

  useEffect(() => cancelClose, [cancelClose])

  const scheduleClose = useCallback(
    (level: number) => {
      cancelClose()
      closeTimer.current = setTimeout(() => {
        closeTimer.current = undefined
        setState((s) => ({
          open: s.open.slice(0, level),
          active: s.active && s.active.level > level ? undefined : s.active,
        }))
      }, SUBMENU_CLOSE_DELAY_MS)
    },
    [cancelClose],
  )

  const onRowEnter = useCallback(
    (level: number, index: number, isSubmenu: boolean) => {
      cancelClose()
      const open = stateRef.current.open
      if (isSubmenu) {
        setState({ open: [...open.slice(0, level), index], active: { level, index } })
        return
      }
      // Keep any deeper panel up for the grace period so a diagonal sweep into
      // it isn't cut off by the sibling rows it passes over.
      if (open.length > level) scheduleClose(level)
      setState({ open, active: { level, index } })
    },
    [cancelClose, scheduleClose],
  )

  /** Level the arrow keys act on: wherever the cursor currently sits. */
  const activeLevel = (s: MenuState): number => s.active?.level ?? s.open.length

  /**
   * Deepest level actually on screen. Hovering a submenu row opens its panel
   * without moving the cursor into it, so this can run ahead of `activeLevel` —
   * and it is what Escape and ArrowLeft must peel off.
   */
  const deepestLevel = (s: MenuState): number => Math.max(s.open.length, s.active?.level ?? 0)

  const collapse = useCallback((): boolean => {
    const s = stateRef.current
    const level = deepestLevel(s)
    if (level === 0) return false
    const parentIndex = s.open[level - 1]
    setState({
      open: s.open.slice(0, level - 1),
      active: parentIndex === undefined ? undefined : { level: level - 1, index: parentIndex },
    })
    return true
  }, [])

  const expand = useCallback((): boolean => {
    const s = stateRef.current
    const level = activeLevel(s)
    const index = s.active?.index
    if (index === undefined) return false
    const row = rowsAtLevel(rowsRef.current, s.open, level)?.[index]
    if (row?.kind !== 'submenu') return false
    const first = stepIndex(row.children, undefined, 1)
    setState({
      open: [...s.open.slice(0, level), index],
      active: first === undefined ? undefined : { level: level + 1, index: first },
    })
    return true
  }, [])

  const onEscape = useCallback((): boolean => {
    cancelClose()
    return collapse()
  }, [cancelClose, collapse])

  // Window capture: the workbench keybinding dispatcher listens on *document*
  // capture, so registering here runs first; stopping propagation also keeps the
  // arrow keys away from whatever tree or list the menu was opened from.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      // Mid-composition Enter commits an IME candidate; it is not ours to take.
      if (e.isComposing || e.altKey || e.ctrlKey || e.metaKey) return
      const s = stateRef.current
      const level = activeLevel(s)
      const levelRows = rowsAtLevel(rowsRef.current, s.open, level)
      if (!levelRows) return

      const move = (next: number | undefined): void => {
        if (next === undefined) return
        cancelClose()
        setState({ open: s.open.slice(0, level), active: { level, index: next } })
      }

      switch (e.key) {
        case 'ArrowDown':
          move(stepIndex(levelRows, s.active?.index, 1))
          break
        case 'ArrowUp':
          move(stepIndex(levelRows, s.active?.index, -1))
          break
        case 'Home':
          move(stepIndex(levelRows, undefined, 1))
          break
        case 'End':
          move(stepIndex(levelRows, undefined, -1))
          break
        case 'ArrowRight':
          cancelClose()
          if (!expand()) return
          break
        case 'ArrowLeft':
          cancelClose()
          if (!collapse()) return
          break
        case 'Enter':
        case ' ': {
          const index = s.active?.index
          const row = index === undefined ? undefined : levelRows[index]
          if (row?.kind === 'item') row.run()
          else if (row?.kind === 'submenu') expand()
          else return
          break
        }
        default:
          return
      }
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [cancelClose, collapse, expand])

  if (rows.length === 0) return null

  return (
    <AnchoredSurface x={anchor.x} y={anchor.y} onClose={onClose} onEscape={onEscape}>
      <MenuRows
        uid={uid}
        rows={rows}
        level={0}
        state={state}
        direction="right"
        onRowEnter={onRowEnter}
        onCancelClose={cancelClose}
      />
    </AnchoredSurface>
  )
}

interface MenuRowsProps {
  readonly uid: string
  readonly rows: readonly RowModel[]
  readonly level: number
  readonly state: MenuState
  readonly direction: SubmenuDirection
  readonly onRowEnter: (level: number, index: number, isSubmenu: boolean) => void
  readonly onCancelClose: () => void
  readonly className?: string | undefined
  readonly style?: React.CSSProperties | undefined
  readonly innerRef?: React.Ref<HTMLUListElement> | undefined
  readonly testId?: string | undefined
}

const rowElementId = (uid: string, level: number, index: number): string =>
  `${uid}-${level}-${index}`

/**
 * One menu level plus, when a submenu row is expanded, the panel for the level
 * below it. Shared by the root menu and every submenu panel so a nested level
 * behaves exactly like the top one, to any depth.
 */
function MenuRows({
  uid,
  rows,
  level,
  state,
  direction,
  onRowEnter,
  onCancelClose,
  className,
  style,
  innerRef,
  testId,
}: MenuRowsProps) {
  const openIndex = state.open[level]
  const active = state.active?.level === level ? state.active.index : undefined
  const openRow = openIndex === undefined ? undefined : rows[openIndex]
  const activeId = active === undefined ? undefined : rowElementId(uid, level, active)

  return (
    <>
      <ul
        ref={innerRef}
        role="menu"
        aria-activedescendant={activeId}
        className={className === undefined ? styles['menu'] : `${styles['menu']} ${className}`}
        {...(style ? { style } : {})}
        {...(testId === undefined ? {} : { 'data-testid': testId })}
        onMouseEnter={onCancelClose}
      >
        {rows.map((row, index) => {
          const id = rowElementId(uid, level, index)
          if (row.kind === 'separator') {
            return <li key={row.id} role="separator" className={styles['separator']} />
          }
          const isActive = index === active || index === openIndex
          const common = {
            id,
            role: 'menuitem' as const,
            tabIndex: -1,
            ...(isActive ? { 'data-active': '' } : {}),
            onMouseEnter: () => onRowEnter(level, index, row.kind === 'submenu'),
          }
          if (row.kind === 'submenu') {
            return (
              <li
                key={row.id}
                {...common}
                aria-haspopup="menu"
                aria-expanded={index === openIndex}
                className={`${styles['item']} ${styles['submenuItem']}`}
              >
                {row.label}
              </li>
            )
          }
          return (
            <li key={row.id} {...common} className={styles['item']} onClick={row.run}>
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
      {openRow?.kind === 'submenu' && openIndex !== undefined && (
        <SubmenuPanel
          key={openRow.id}
          uid={uid}
          rows={openRow.children}
          level={level + 1}
          state={state}
          direction={direction}
          parentRowId={rowElementId(uid, level, openIndex)}
          onRowEnter={onRowEnter}
          onCancelClose={onCancelClose}
        />
      )}
    </>
  )
}

interface SubmenuPanelProps extends Omit<
  MenuRowsProps,
  'className' | 'style' | 'innerRef' | 'testId'
> {
  readonly parentRowId: string
}

function SubmenuPanel({ parentRowId, direction, ...rest }: SubmenuPanelProps) {
  const ref = useRef<HTMLUListElement>(null)

  const compute = useCallback(
    (panel: IViewportSize, viewport: IViewportSize) => {
      const el = ref.current
      // Line the panel's first row up with the parent row rather than with the
      // parent menu's padding edge.
      const padding = parseFloat(
        el?.ownerDocument.defaultView?.getComputedStyle(el).paddingTop ?? '',
      )
      const paddingTop = Number.isFinite(padding) ? padding : 0
      const parent = el?.ownerDocument.getElementById(parentRowId)?.getBoundingClientRect()
      return computeSubmenuPosition(
        viewport,
        panel,
        {
          top: (parent?.top ?? 0) - paddingTop,
          left: parent?.left ?? 0,
          width: parent?.width ?? 0,
          height: (parent?.height ?? 0) + 2 * paddingTop,
        },
        direction,
      )
    },
    [parentRowId, direction],
  )

  const { placement, style } = useTransformFreePlacement(ref, compute)

  return (
    <MenuRows
      {...rest}
      direction={placement?.direction ?? direction}
      innerRef={ref}
      className={styles['submenu']}
      testId="context-menu-submenu"
      style={style}
    />
  )
}
