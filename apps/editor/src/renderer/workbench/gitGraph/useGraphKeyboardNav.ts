/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  useGraphKeyboardNav — arrow-key / Home / End / PageUp / PageDown navigation
 *  plus Ctrl/Cmd+Enter menu invocation for the commit-graph row lists (Git Graph
 *  and Perforce Graph). The host makes its scroll container focusable and wires
 *  the returned handler as its onKeyDown; selection changes go through the same
 *  entry point as mouse clicks, so latest-wins sequencing and payload caching
 *  are preserved. Only the listed navigation keys are handled (and prevented) —
 *  everything else bubbles up untouched.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, type KeyboardEvent, type RefObject } from 'react'

export interface GraphKeyboardNavOptions {
  /** Keys of the currently rendered rows, top to bottom (after filtering). */
  readonly rows: readonly string[]
  /** Mirror of the current selection; [0] is the anchor row. */
  readonly selectionRef: RefObject<string[]>
  /** Select a single row (no toggle semantics). */
  readonly select: (key: string) => void
  /** Open the context menu for a row (Ctrl/Cmd+Enter). */
  readonly openMenu: (key: string) => void
  /** The focusable scroll container wrapping the rows. */
  readonly scrollRef: RefObject<HTMLDivElement | null>
  /** Row attribute used to locate the row element for scroll-into-view. */
  readonly rowAttribute: 'data-hash' | 'data-id'
  readonly rowHeight: number
}

export function useGraphKeyboardNav({
  rows,
  selectionRef,
  select,
  openMenu,
  scrollRef,
  rowAttribute,
  rowHeight,
}: GraphKeyboardNavOptions): (e: KeyboardEvent<HTMLDivElement>) => void {
  return useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (rows.length === 0) return
      const currentKey = selectionRef.current[0]
      const currentIndex = currentKey === undefined ? -1 : rows.indexOf(currentKey)

      const moveTo = (index: number) => {
        const clamped = Math.max(0, Math.min(rows.length - 1, index))
        const key = rows[clamped]!
        select(key)
        // getAttribute comparison instead of a `[${rowAttribute}="${...}"]`
        // selector: attribute-string escapes are not honoured by every selector
        // engine (happy-dom in tests).
        const row = scrollRef.current
          ?.querySelectorAll(`[${rowAttribute}]`)
          .values()
          .find((el) => el.getAttribute(rowAttribute) === key)
        row?.scrollIntoView({ block: 'nearest' })
      }

      switch (e.key) {
        case 'ArrowDown':
        case 'ArrowUp': {
          if (e.ctrlKey || e.metaKey || e.altKey) return
          e.preventDefault()
          if (currentIndex < 0) {
            moveTo(e.key === 'ArrowDown' ? 0 : rows.length - 1)
          } else {
            moveTo(currentIndex + (e.key === 'ArrowDown' ? 1 : -1))
          }
          return
        }
        case 'Home':
        case 'End': {
          if (e.ctrlKey || e.metaKey || e.altKey) return
          e.preventDefault()
          moveTo(e.key === 'Home' ? 0 : rows.length - 1)
          return
        }
        case 'PageDown':
        case 'PageUp': {
          if (e.ctrlKey || e.metaKey || e.altKey) return
          e.preventDefault()
          const pageSize = Math.max(
            1,
            Math.floor((scrollRef.current?.clientHeight ?? 0) / rowHeight),
          )
          const base = currentIndex < 0 ? 0 : currentIndex
          moveTo(base + (e.key === 'PageDown' ? pageSize : -pageSize))
          return
        }
        case 'Enter': {
          if (!(e.ctrlKey || e.metaKey) || e.altKey || currentKey === undefined) return
          e.preventDefault()
          openMenu(currentKey)
          return
        }
        default:
          return
      }
    },
    [rows, selectionRef, select, openMenu, scrollRef, rowAttribute, rowHeight],
  )
}
