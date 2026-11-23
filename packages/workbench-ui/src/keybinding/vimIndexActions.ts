/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Shared Vim surface actions for anything that is "an indexed row of items": a
 *  vertical list / tree / overlay (`createIndexListVimActions`) or a horizontal
 *  tab strip (`createStripVimActions`). Pure functions, no DOM beyond the optional
 *  scroller, no DI — hosts supply getters that read their latest state, so the
 *  helpers can be rebuilt every render and handed to `useVimSurface`.
 *
 *  Count semantics (one rule for every surface): `first(count)` / `last(count)`
 *  receive 0 when no count was typed (`gg` = first item, `G` = last item) and the
 *  typed number otherwise; `n >= 1` jumps to the n-th item (1-based, clamped), so
 *  `1G` is the first item while `G` is the last.
 *--------------------------------------------------------------------------------------------*/

import { LIST_PAGE_STEP, resolveIndexNavigation } from '../list/listKeyboard.js'
import { scrollViewportByRows } from '../list/scrollViewport.js'
import type { IVimSurfaceActions } from './vim/vimTypes.js'

export type VimGotoEdge = 'first' | 'last'

/**
 * Index `gg` / `G` (with an optional count, 0 = none typed) lands on among
 * `total` items, or -1 when there are none. Callers that skip rows (disabled options, separators)
 * pass the number of *selectable* rows and map the result back themselves.
 */
export function resolveVimGotoIndex(edge: VimGotoEdge, count: number, total: number): number {
  if (total <= 0) return -1
  if (count >= 1) return Math.min(total - 1, Math.floor(count) - 1)
  return edge === 'first' ? 0 : total - 1
}

export interface IIndexListScroller {
  /** The element whose `scrollTop` moves (read at keystroke time). */
  readonly getElement: () => HTMLElement | null
  /** Row height for `Ctrl+E/Y`; falls back to the shared default when omitted. */
  readonly getRowHeight?: (() => number | undefined) | undefined
}

export interface IIndexListVimOptions {
  readonly getCount: () => number
  /** Focused index; -1 when nothing is focused. */
  readonly getIndex: () => number
  /** Move the cursor to a valid index (host selects + reveals). */
  readonly setIndex: (index: number) => void
  /** Rows per `Ctrl+D/U` step before the count multiplier; defaults to LIST_PAGE_STEP. */
  readonly getPageSize?: (() => number) | undefined
  /** Adds `scrollViewport` (Ctrl+E/Y) when provided. */
  readonly scroller?: IIndexListScroller | undefined
  /**
   * Where `k` lands when no row is focused yet. Lists start from the top; the
   * commit graph starts from the bottom.
   */
  readonly upFromNone?: 'first' | 'last' | undefined
}

export type IIndexListVimActions = Required<
  Pick<IVimSurfaceActions, 'move' | 'first' | 'last' | 'page'>
> &
  Pick<IVimSurfaceActions, 'scrollViewport'>

/**
 * `move` handles only up/down; left/right are structural (tree expand, host
 * defined) and stay with the host, which can override `move` after spreading.
 */
export function createIndexListVimActions(options: IIndexListVimOptions): IIndexListVimActions {
  const { getCount, getIndex, setIndex, getPageSize, scroller, upFromNone = 'first' } = options
  const clampIndex = (index: number, total: number): number =>
    Math.max(0, Math.min(total - 1, index))

  const actions: IIndexListVimActions = {
    move: (direction, count) => {
      if (direction !== 'up' && direction !== 'down') return
      const total = getCount()
      if (total <= 0) return
      const steps = Math.max(1, count)
      const index = getIndex()
      let target: number
      if (index < 0)
        target = direction === 'down' ? steps - 1 : upFromNone === 'last' ? total - steps : 0
      else target = index + (direction === 'down' ? steps : -steps)
      setIndex(clampIndex(target, total))
    },
    first: (count) => {
      const target = resolveVimGotoIndex('first', count, getCount())
      if (target >= 0) setIndex(target)
    },
    last: (count) => {
      const target = resolveVimGotoIndex('last', count, getCount())
      if (target >= 0) setIndex(target)
    },
    page: (direction, count) => {
      const total = getCount()
      if (total <= 0) return
      const next = resolveIndexNavigation(direction === 'down' ? 'PageDown' : 'PageUp', {
        index: getIndex(),
        count: total,
        pageSize: (getPageSize?.() ?? LIST_PAGE_STEP) * Math.max(1, count),
      })
      if (next !== undefined) setIndex(next)
    },
    ...(scroller === undefined
      ? {}
      : {
          scrollViewport: (direction: 'up' | 'down', count: number) =>
            scrollViewportByRows(
              scroller.getElement(),
              scroller.getRowHeight?.(),
              direction,
              count,
            ),
        }),
  }
  return actions
}

export interface IStripVimOptions {
  readonly getCount: () => number
  /** Current (active / roving) index; -1 when there is none. */
  readonly getIndex: () => number
  readonly setIndex: (index: number) => void
  /** h/l and next/previous cycle around the ends instead of clamping. */
  readonly wrap?: boolean | undefined
}

export type IStripVimActions = Required<
  Pick<IVimSurfaceActions, 'move' | 'next' | 'previous' | 'first' | 'last'>
>

export function createStripVimActions(options: IStripVimOptions): IStripVimActions {
  const { getCount, getIndex, setIndex, wrap = false } = options

  const step = (delta: number): void => {
    const total = getCount()
    if (total <= 0) return
    // Cycling a single item is a no-op; clamping it is harmless either way.
    if (wrap && total < 2) return
    const index = getIndex()
    let target: number
    if (index < 0) target = wrap && delta < 0 ? total - 1 : 0
    else if (wrap) target = (((index + delta) % total) + total) % total
    else target = Math.max(0, Math.min(total - 1, index + delta))
    setIndex(target)
  }

  const goto = (edge: VimGotoEdge, count: number): void => {
    const target = resolveVimGotoIndex(edge, count, getCount())
    if (target >= 0) setIndex(target)
  }

  return {
    move: (direction, count) => {
      const backwards = direction === 'left' || direction === 'up'
      step((backwards ? -1 : 1) * Math.max(1, count))
    },
    next: (count) => step(Math.max(1, count)),
    previous: (count) => step(-Math.max(1, count)),
    first: (count) => goto('first', count),
    last: (count) => goto('last', count),
  }
}
