/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  useFlatListNavigation — keyboard navigation for flat row lists, the sibling of
 *  `Tree` for data that has no hierarchy.
 *
 *  Same mental model as `Tree`, deliberately: the *container* holds DOM focus and
 *  carries tabIndex={0}; rows are not tab stops, they are data identified by
 *  `data-row-key` and marked with `aria-selected`. Keeping the two in step is the
 *  point — a list view should not feel different from a tree view, and a fix to
 *  one navigation model should not have to be ported to a second one. Index
 *  arithmetic itself lives in `listKeyboard.ts`, shared with `Tree`.
 *
 *  Focus is **controlled**: every caller already owns a selection (`selectedId` /
 *  `activeId` / `selectedRowId`), so an internal copy would only be a second
 *  source of truth to reconcile. The hook keeps exactly one piece of state — the
 *  container's own focus flag, mirrored to `data-focused` (which e2e asserts on).
 *  The one place it drives the cursor rather than reading it is on focus, where
 *  an empty cursor is seeded onto the first row (see `focusSelectsFirst`); if the
 *  rows have not arrived yet, that seed is deferred until they do.
 *
 *  ARIA note: like `Tree`, this uses container focus + `aria-selected` rather than
 *  `aria-activedescendant` or roving tabindex. That is the house convention; if it
 *  is ever revisited, `Tree` and this hook must move together.
 *--------------------------------------------------------------------------------------------*/

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from 'react'
import { resolveIndexNavigation } from './listKeyboard.js'
import {
  dispatchKeyboardContextMenu,
  findRowElement,
  isContextMenuKey,
  isKeyupContextMenuSupplement,
} from '../tree/keyboardContextMenu.js'

const DEFAULT_ROW_ATTR = 'data-row-key'

export interface IFlatListActivateOptions {
  /** True for a light "preview" open (Space); false to commit (Enter). */
  readonly preview: boolean
}

export type FlatListRole = 'listbox' | 'grid'

export interface IUseFlatListNavigationOptions {
  readonly count: number
  /** Controlled focused row; -1 when nothing is focused. */
  readonly focusedIndex: number
  readonly onFocusChange: (index: number) => void
  /** Stable per-index id — becomes the row attribute and the reveal lookup key. */
  readonly getItemKey: (index: number) => string
  /** Reads the container element (pass a stable callback backed by a ref). */
  readonly getContainer: () => HTMLElement | null
  /**
   * Enter / Space. When omitted, both keys are left alone so they can reach a
   * globally registered command instead (the keybindings grid routes them
   * through Action2).
   */
  readonly onActivate?: ((index: number, opts: IFlatListActivateOptions) => void) | undefined
  /** Keys not handled here (Delete / F2 / …) reach the view, un-defaulted. */
  readonly onRowKeyDown?: ((e: KeyboardEvent, index: number) => void) | undefined
  /** Shift+Tab inside the list — hand focus back to a prior region (a search box). */
  readonly onShiftTab?: (() => void) | undefined
  readonly role?: FlatListRole | undefined
  readonly ariaLabel?: string | undefined
  readonly ariaRowCount?: number | undefined
  /** Rows per page; read at keydown time so a resize is picked up. */
  readonly getPageSize?: (() => number) | undefined
  /** Virtualized lists: scroll a row that is outside the rendered window. */
  readonly scrollToIndex?: ((index: number) => void) | undefined
  /** Row identity attribute; defaults to `data-row-key`. */
  readonly rowDataAttr?: string | undefined
  /**
   * Landing focus on the container with no row under the cursor selects the
   * first row. Defaults to true — this is the flat-list counterpart of the
   * `onFocus` seeding every Tree view does, and without it a list reacts to
   * nothing until a key is pressed, which reads as "focus selected nothing".
   * Keybindings passes false: its `keybindingFocus` context key must stay
   * unset until a key actually moves the cursor, matching VSCode's keybindings
   * editor, which does not preselect a row either.
   */
  readonly focusSelectsFirst?: boolean | undefined
}

export interface IFlatListContainerProps {
  readonly role: FlatListRole
  readonly 'aria-label': string | undefined
  readonly 'aria-rowcount': number | undefined
  readonly tabIndex: 0
  readonly 'data-focused': boolean
  readonly onKeyDown: (e: KeyboardEvent) => void
  readonly onMouseDown: () => void
  readonly onFocus: () => void
  readonly onBlur: () => void
  readonly onContextMenu: (e: MouseEvent) => void
}

export interface IFlatListRowProps {
  readonly role: 'option' | 'row'
  readonly 'aria-selected': boolean
  readonly onClick: (e: MouseEvent) => void
  readonly [rowAttr: string]: unknown
}

export interface IFlatListNavigation {
  readonly containerProps: IFlatListContainerProps
  /** Identity + ARIA + default click. Spread first, then your own handlers. */
  readonly getRowProps: (index: number) => IFlatListRowProps
  /** Move focus programmatically and scroll the row into view. */
  readonly focusRow: (index: number) => void
  /** True while the container subtree holds DOM focus. */
  readonly hasFocus: boolean
}

export function useFlatListNavigation(options: IUseFlatListNavigationOptions): IFlatListNavigation {
  const [hasFocus, setHasFocus] = useState(false)

  // Set when focus lands on a list that has no rows to seed yet, cleared once it
  // is honoured or focus leaves. Lists whose rows arrive over IPC can be focused
  // before their data does, and `onFocus` is a one-shot DOM event that will not
  // fire again — without this latch such a list stays cursor-less until a key is
  // pressed, which is the symptom the seed exists to prevent.
  const seedPending = useRef(false)

  // Everything the handlers read goes through a ref so the returned callbacks
  // keep a stable identity across renders — consumers spread them onto every
  // row, and a fresh handler per render would defeat their memoization.
  const optionsRef = useRef(options)
  optionsRef.current = options

  const revealRow = useCallback((index: number) => {
    const { getContainer, getItemKey, rowDataAttr, scrollToIndex, count } = optionsRef.current
    if (index < 0 || index >= count) return
    const container = getContainer()
    if (container) {
      const row = findRowElement(container, rowDataAttr ?? DEFAULT_ROW_ATTR, getItemKey(index))
      if (row) {
        row.scrollIntoView({ block: 'nearest' })
        return
      }
    }
    // Not in the DOM: the row is outside a virtualizer's rendered window.
    scrollToIndex?.(index)
  }, [])

  const focusRow = useCallback(
    (index: number) => {
      const { count, onFocusChange } = optionsRef.current
      if (index < 0 || index >= count) return
      onFocusChange(index)
      revealRow(index)
    },
    [revealRow],
  )

  const openContextMenu = useCallback(() => {
    const { getContainer, getItemKey, rowDataAttr, focusedIndex, count } = optionsRef.current
    const container = getContainer()
    if (!container) return
    // A cursor that sits nowhere anchors on the first row, the same way
    // `resolveIndexNavigation` treats -1 as 0 — otherwise the key would be a
    // no-op precisely when the user has just tabbed in and has no other way to
    // reach the menu.
    const anchorIndex = focusedIndex < 0 ? 0 : focusedIndex
    const row =
      anchorIndex < count
        ? findRowElement(container, rowDataAttr ?? DEFAULT_ROW_ATTR, getItemKey(anchorIndex))
        : null
    dispatchKeyboardContextMenu(row ?? container, row !== null)
  }, [])

  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const { count, focusedIndex, onActivate, onRowKeyDown, onShiftTab, getPageSize } =
        optionsRef.current

      // Modifier combos belong to the global keybinding handler (Tree parity) —
      // swallowing them here would break Ctrl+P/N and friends over the list.
      if (e.altKey || e.ctrlKey || e.metaKey) return
      // A keydown bubbling up from an inner control (an inline editor, a row
      // button) is that control's key, not the list's. VSCode draws the same
      // line with listFocus vs. whenFocus context gating.
      if (e.target !== e.currentTarget) return

      if (e.key === 'Tab' && e.shiftKey && onShiftTab) {
        e.preventDefault()
        e.stopPropagation()
        onShiftTab()
        return
      }

      if (count === 0) return

      const next = resolveIndexNavigation(e.key, {
        index: focusedIndex,
        count,
        pageSize: getPageSize?.(),
      })
      if (next !== undefined) {
        e.preventDefault()
        e.stopPropagation()
        focusRow(next)
        return
      }

      // Without an onActivate these keys are left for a global command.
      if (onActivate && (e.key === 'Enter' || e.key === ' ')) {
        if (focusedIndex < 0 || focusedIndex >= count) return
        e.preventDefault()
        e.stopPropagation()
        onActivate(focusedIndex, { preview: e.key === ' ' })
        return
      }

      // `repeat` guard: holding the key must not stack menus.
      if (isContextMenuKey(e)) {
        e.preventDefault()
        e.stopPropagation()
        if (!e.repeat) openContextMenu()
        return
      }

      if (focusedIndex >= 0 && focusedIndex < count) onRowKeyDown?.(e, focusedIndex)
    },
    [focusRow, openContextMenu],
  )

  const onMouseDown = useCallback(() => {
    // preventScroll: focusing the container must not yank the list to the top.
    optionsRef.current.getContainer()?.focus({ preventScroll: true })
  }, [])

  const onContextMenu = useCallback((e: MouseEvent) => {
    // Chromium re-dispatches a contextmenu on keyup that keydown's
    // preventDefault cannot cancel; swallow it or the keystroke opens a second
    // menu in the screen corner.
    if (isKeyupContextMenuSupplement(e)) e.preventDefault()
  }, [])

  // Seed the cursor on the first row so the arrows have somewhere to start. This
  // only moves resolveIndexNavigation's existing treatment of index < 0
  // (ArrowDown from nowhere already lands on 0) forward to focus time —
  // otherwise nothing visibly reacts until the first keystroke. Returns false
  // only when there was a seed to do and no row to do it with.
  const seedFirstRow = useCallback((): boolean => {
    const { focusedIndex, count, onFocusChange, focusSelectsFirst } = optionsRef.current
    if (focusSelectsFirst === false || focusedIndex >= 0) return true
    if (count === 0) return false
    onFocusChange(0)
    return true
  }, [])

  const onFocus = useCallback(() => {
    setHasFocus(true)
    seedPending.current = !seedFirstRow()
  }, [seedFirstRow])
  const onBlur = useCallback(() => {
    setHasFocus(false)
    seedPending.current = false
  }, [])

  // Honour a seed that arrived too early. Deliberately gated on `seedPending`
  // rather than on `hasFocus && focusedIndex < 0`: consumers drop the cursor on
  // purpose when a refresh loses the row it pointed at, and re-seeding there
  // would overrule them.
  useEffect(() => {
    if (!seedPending.current) return
    if (seedFirstRow()) seedPending.current = false
  })

  const getRowProps = useCallback((index: number): IFlatListRowProps => {
    const { getItemKey, rowDataAttr, role, focusedIndex, onFocusChange } = optionsRef.current
    return {
      [rowDataAttr ?? DEFAULT_ROW_ATTR]: getItemKey(index),
      role: (role ?? 'listbox') === 'grid' ? 'row' : 'option',
      'aria-selected': focusedIndex === index,
      onClick: () => onFocusChange(index),
    }
  }, [])

  return {
    containerProps: {
      role: options.role ?? 'listbox',
      'aria-label': options.ariaLabel,
      'aria-rowcount': options.ariaRowCount,
      tabIndex: 0,
      'data-focused': hasFocus,
      onKeyDown,
      onMouseDown,
      onFocus,
      onBlur,
      onContextMenu,
    },
    getRowProps,
    focusRow,
    hasFocus,
  }
}
