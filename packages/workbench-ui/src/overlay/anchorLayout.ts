/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  anchorLayout — viewport-aware placement maths for popups anchored to an element.
 *  Ported from VSCode's `vs/base/common/layout.ts` (one-dimensional `layout`) and
 *  the submenu placement in `vs/base/browser/ui/menu/menu.ts`. Kept as pure
 *  functions so the geometry is unit-testable without a DOM (jsdom/happy-dom
 *  report every rect as zero, so this is the only layer where the maths can
 *  actually be asserted).
 *--------------------------------------------------------------------------------------------*/

/** Which side of the anchor the view prefers: `before` = after the anchor's far edge. */
export type LayoutAnchorPosition = 'before' | 'after'

/**
 * `avoid` keeps the view clear of the anchor box (menus hanging off a row).
 * `align` lets the view start at the anchor's own edge (dropdowns lining up
 * with their button).
 */
export type LayoutAnchorMode = 'avoid' | 'align'

export interface ILayoutAnchor {
  readonly offset: number
  readonly size: number
  readonly position: LayoutAnchorPosition
  readonly mode?: LayoutAnchorMode
}

export interface ILayoutResult {
  readonly position: number
  readonly result: 'ok' | 'flipped' | 'overlap'
}

/**
 * Lays out a one-dimensional view next to an anchor inside a viewport, in three
 * stages: fits on the preferred side → flips to the other side → overlaps the
 * anchor clamped to the viewport edge.
 */
export function layout(
  viewportSize: number,
  viewSize: number,
  anchor: ILayoutAnchor,
): ILayoutResult {
  const afterBoundary = anchor.mode === 'align' ? anchor.offset : anchor.offset + anchor.size
  const beforeBoundary = anchor.mode === 'align' ? anchor.offset + anchor.size : anchor.offset

  if (anchor.position === 'before') {
    if (viewSize <= viewportSize - afterBoundary) {
      return { position: afterBoundary, result: 'ok' }
    }
    if (viewSize <= beforeBoundary) {
      return { position: beforeBoundary - viewSize, result: 'flipped' }
    }
    return { position: Math.max(viewportSize - viewSize, 0), result: 'overlap' }
  }

  if (viewSize <= beforeBoundary) {
    return { position: beforeBoundary - viewSize, result: 'ok' }
  }
  // The half-size guard stops a flip into a sliver of space that is even worse
  // than overlapping the anchor.
  if (viewSize <= viewportSize - afterBoundary && beforeBoundary < viewSize / 2) {
    return { position: afterBoundary, result: 'flipped' }
  }
  return { position: 0, result: 'overlap' }
}

/** Horizontal side a submenu expands towards; inherited by deeper levels. */
export type SubmenuDirection = 'right' | 'left'

export interface IViewportSize {
  readonly width: number
  readonly height: number
}

export interface IAnchorRect {
  readonly top: number
  readonly left: number
  readonly width: number
  readonly height: number
}

export interface ISubmenuPosition {
  readonly top: number
  readonly left: number
  /** The side actually used — pass it down so a flipped chain keeps expanding left. */
  readonly direction: SubmenuDirection
}

/**
 * Places a submenu panel next to the parent row it hangs off. Mirrors VSCode's
 * `calculateSubmenuMenuLayout`, including its two nudges: shifting right when
 * the panel would land on top of the row, and dropping below the row when the
 * panel had to flip upwards.
 */
export function computeSubmenuPosition(
  viewport: IViewportSize,
  submenu: IViewportSize,
  entry: IAnchorRect,
  direction: SubmenuDirection,
): ISubmenuPosition {
  const horizontal = layout(viewport.width, submenu.width, {
    offset: entry.left,
    size: entry.width,
    position: direction === 'right' ? 'before' : 'after',
  })

  let left = horizontal.position
  let entryTop = entry.top
  let entryHeight = entry.height

  // Not enough room on either side, so the panel overlaps the row: nudge it
  // clear of the label and stop treating the row as a vertical obstacle.
  if (left >= entry.left && left < entry.left + entry.width) {
    if (entry.left + 10 + submenu.width <= viewport.width) left = entry.left + 10
    entryTop += 10
    entryHeight = 0
  }

  const vertical = layout(viewport.height, submenu.height, {
    offset: entryTop,
    size: 0,
    position: 'before',
  })

  let top = vertical.position
  // Flipped upwards but the row's own height still fits below the flip point:
  // slide down so the panel's bottom aligns with the row instead of its top.
  if (top + submenu.height === entryTop && top + entryHeight + submenu.height <= viewport.height) {
    top += entryHeight
  }

  return {
    top,
    left,
    direction: horizontal.result === 'flipped' ? flipDirection(direction) : direction,
  }
}

function flipDirection(direction: SubmenuDirection): SubmenuDirection {
  return direction === 'right' ? 'left' : 'right'
}

/**
 * Clamps a popup anchored at a point (a right-click menu) fully inside the
 * viewport, preferring below-right of the point.
 */
export function computePointAnchoredPosition(
  viewport: IViewportSize,
  view: IViewportSize,
  point: { readonly x: number; readonly y: number },
): { readonly top: number; readonly left: number } {
  return {
    left: layout(viewport.width, view.width, { offset: point.x, size: 0, position: 'before' })
      .position,
    top: layout(viewport.height, view.height, { offset: point.y, size: 0, position: 'before' })
      .position,
  }
}
