/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Spatial part lookup for `workbench.action.navigate*`: which part lies in a
 *  direction from the focused one. Pure geometry over the parts' rectangles, so
 *  a right-hand side bar or a moved panel needs no special case.
 *--------------------------------------------------------------------------------------------*/

export type NavigateDirection = 'left' | 'right' | 'up' | 'down'

export interface PartRect {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

export interface PartCandidate<T> {
  readonly id: T
  readonly rect: PartRect
}

// Sashes and borders make neighbouring rectangles touch or overlap by a pixel.
const EDGE_TOLERANCE = 2

function overlap(a0: number, a1: number, b0: number, b1: number): number {
  return Math.min(a1, b1) - Math.max(a0, b0)
}

/**
 * The candidate entirely on the `direction` side of `from` that shares the most
 * of the perpendicular span, nearest first. Undefined at the workbench edge.
 */
export function findPartInDirection<T>(
  from: PartRect,
  candidates: readonly PartCandidate<T>[],
  direction: NavigateDirection,
): T | undefined {
  let best: { id: T; gap: number; shared: number } | undefined
  for (const { id, rect } of candidates) {
    let gap: number
    let shared: number
    switch (direction) {
      case 'left':
        gap = from.left - rect.right
        shared = overlap(from.top, from.bottom, rect.top, rect.bottom)
        break
      case 'right':
        gap = rect.left - from.right
        shared = overlap(from.top, from.bottom, rect.top, rect.bottom)
        break
      case 'up':
        gap = from.top - rect.bottom
        shared = overlap(from.left, from.right, rect.left, rect.right)
        break
      case 'down':
        gap = rect.top - from.bottom
        shared = overlap(from.left, from.right, rect.left, rect.right)
        break
    }
    if (gap < -EDGE_TOLERANCE || shared <= 0) continue
    if (best === undefined || gap < best.gap || (gap === best.gap && shared > best.shared)) {
      best = { id, gap, shared }
    }
  }
  return best?.id
}
