/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  useMenuNavigation — the keyboard half of every menu in the workbench: arrow
 *  stepping across separators (with Ctrl+P/N/H/L as their aliases), Home/End,
 *  submenu expand/collapse, Enter/Space, and the opening highlight. Navigation
 *  moves a *virtual* focus (`aria-activedescendant`) rather than DOM focus, so
 *  the tree or list that raised the menu keeps its own focus ring and selection.
 *
 *  Shared by `ContextMenu` (MenuRegistry-driven) and `ListMenu` (item-driven) so
 *  the two can never drift apart.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useRef, useState } from 'react'
import { ctrlNavigationKey, type CtrlNavigationKey } from '../keybinding/ctrlNavigation.js'
import { rowsAtLevel, stepIndex, type RowModel } from './menuModel.js'

/**
 * Hovering a sibling row does not tear the open panel down straight away: a
 * diagonal sweep from the parent row into its panel passes over siblings, and
 * closing on the first of those would make the panel unreachable by mouse.
 */
const SUBMENU_CLOSE_DELAY_MS = 250

/** Ctrl+P/N/H/L stand in for the four arrow keys while a menu owns the keyboard. */
const CTRL_NAV_ARROWS: Record<
  CtrlNavigationKey,
  'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight'
> = { h: 'ArrowLeft', l: 'ArrowRight', n: 'ArrowDown', p: 'ArrowUp' }

/** The row the keyboard acts on, addressed by its depth and index. */
export interface MenuActive {
  readonly level: number
  readonly index: number
}

export interface MenuState {
  /** Index of the expanded submenu row at each open level, root-first. */
  readonly open: readonly number[]
  readonly active: MenuActive | undefined
}

const INITIAL_STATE: MenuState = { open: [], active: undefined }

export interface MenuNavigation {
  readonly state: MenuState
  readonly onRowEnter: (level: number, index: number, isSubmenu: boolean) => void
  readonly onCancelClose: () => void
  readonly onEscape: () => boolean
}

export function useMenuNavigation(
  rows: readonly RowModel[],
  autoFocusFirst: boolean,
  /**
   * Master switch for the window-level keyboard listener. Menus that resolved
   * to zero rows never render, so they must not arm navigation — otherwise the
   * capture-phase listener stays up (nothing can ever close the menu) and
   * swallows ArrowUp/ArrowDown from whatever view raised it.
   */
  enabled = true,
  /**
   * Opening highlight override for keyboard-raised menus, as the index path
   * from the root down to the target row (length 1 = a top-level row). Every
   * prefix must land on a submenu row — those panels open expanded — and the
   * final row must be navigable. When the path is missing or stale the hook
   * falls back to the first row. Ignored for mouse-opened menus
   * (`autoFocusFirst === false`), which stay unhighlighted. The caller resolves
   * "last executed command id" to a path; the hook itself stays id-agnostic.
   */
  initialActivePath?: readonly number[] | undefined,
): MenuNavigation {
  // Lazy initializer: `rows` is final on the first render (both flavours resolve
  // synchronously), so the opening highlight lands on the right row without an
  // extra effect + re-render.
  const [state, setState] = useState<MenuState>(() => {
    if (!autoFocusFirst) return INITIAL_STATE
    // A caller-supplied path (e.g. the last-executed row, possibly nested) takes
    // precedence, falling back to the first navigable row when missing or stale.
    // Walk the path against the row tree: each prefix step must be a submenu
    // (its panel opens expanded), the final step any navigable row. A path into
    // a submenu lands directly on the nested row — Enter runs it straight away.
    let requested: MenuActive | undefined
    let requestedOpen: readonly number[] = []
    if (initialActivePath !== undefined && initialActivePath.length > 0) {
      let levelRows: readonly RowModel[] = rows
      let level = 0
      let valid = true
      while (valid && level < initialActivePath.length) {
        const index = initialActivePath[level]
        const row = index === undefined ? undefined : levelRows[index]
        const navigable =
          row !== undefined &&
          row.kind !== 'separator' &&
          !(row.kind === 'item' && row.disabled === true)
        if (!navigable || row === undefined) {
          valid = false
        } else if (level === initialActivePath.length - 1) {
          requested = { level, index: index as number }
          break
        } else if (row.kind === 'submenu') {
          levelRows = row.children
          level++
        } else {
          // A non-final step on a plain item: the path claims it has children,
          // it does not — stale memory from an older menu shape.
          valid = false
        }
      }
      if (!valid) requested = undefined
      else requestedOpen = initialActivePath.slice(0, -1)
    }
    if (requested === undefined) {
      const first = stepIndex(rows, undefined, 1)
      return first === undefined ? INITIAL_STATE : { open: [], active: { level: 0, index: first } }
    }
    return { open: requestedOpen, active: requested }
  })
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

  // A menu raised by the keyboard can materialize directly under a stationary
  // cursor, and the browser then fires a synthetic mouseenter that would steal
  // the opening highlight from the row the user is about to press Enter on.
  // Hover only takes over once the pointer has demonstrably moved.
  const hoverArmed = useRef(!autoFocusFirst)
  useEffect(() => {
    if (hoverArmed.current) return
    const arm = (): void => {
      hoverArmed.current = true
    }
    window.addEventListener('mousemove', arm, { once: true, capture: true })
    return () => window.removeEventListener('mousemove', arm, true)
  }, [])

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
      // See `hoverArmed`: an opening highlight outranks the synthetic hover the
      // browser fires when the menu lands under a still cursor.
      if (!hoverArmed.current) return
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
    if (!enabled) return
    const onKeyDown = (e: KeyboardEvent): void => {
      // Mid-composition Enter commits an IME candidate; it is not ours to take.
      if (e.isComposing || e.altKey || e.metaKey) return
      // Ctrl is ours only for the four aliases. Any other Ctrl stroke —
      // Ctrl+Left, Ctrl+Enter, the Ctrl+K chord leader — keeps its global
      // meaning, and Alt/Meta stay out entirely so Alt+ArrowDown and Cmd+ArrowDown
      // never fall through to the plain arrow cases below. One casualty is a
      // chord *completing* on an alias: Ctrl+K Ctrl+L lands on a menu that wants
      // 'l' for ArrowRight, so the stroke is swallowed and the chord times out.
      const alias = ctrlNavigationKey(e)
      if (e.ctrlKey && alias === undefined) return
      const key = alias === undefined ? e.key : CTRL_NAV_ARROWS[alias]
      const s = stateRef.current
      const level = activeLevel(s)
      const levelRows = rowsAtLevel(rowsRef.current, s.open, level)
      // Nothing to step through at this level. The arrows fall through to the
      // view underneath — that is how they reach the tree that raised the menu —
      // but an alias stays ours: leaking Ctrl+H would pop the Replace widget on
      // top of it. Same split in the ArrowLeft/ArrowRight cases below.
      if (!levelRows) {
        if (alias === undefined) return
        e.preventDefault()
        e.stopPropagation()
        return
      }

      const move = (next: number | undefined): void => {
        if (next === undefined) return
        cancelClose()
        setState({ open: s.open.slice(0, level), active: { level, index: next } })
      }

      switch (key) {
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
          if (!expand() && alias === undefined) return
          break
        case 'ArrowLeft':
          cancelClose()
          if (!collapse() && alias === undefined) return
          break
        case 'Enter':
        case ' ': {
          const index = s.active?.index
          const row = index === undefined ? undefined : levelRows[index]
          if (row?.kind === 'item') {
            // A disabled row is inert, but the key still belongs to the menu —
            // swallow it rather than letting it reach the list underneath.
            if (row.disabled !== true) row.run()
          } else if (row?.kind === 'submenu') expand()
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
  }, [enabled, cancelClose, collapse, expand])

  return { state, onRowEnter, onCancelClose: cancelClose, onEscape }
}
