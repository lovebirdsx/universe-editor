/*---------------------------------------------------------------------------------------------
 *  Repro + coverage for the resize-edge guard.
 *
 *  Bug: dragging the sidebar resize sash occasionally starts an Explorer row
 *  drag instead, because the `draggable` row fills the pane's full width and its
 *  right edge overlaps the (thin) resize sash. A press a few px off the sash
 *  hits the row and the browser begins a content drag.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { isResizeEdgeDrag, RESIZE_EDGE_PX } from '../dnd/resizeEdgeGuard.js'

const el = (left: number, right: number) => ({ getBoundingClientRect: () => ({ left, right }) })
const rect = el(0, 200)

describe('isResizeEdgeDrag', () => {
  it('suppresses a press on the right edge (where the primary sidebar sash lives)', () => {
    expect(isResizeEdgeDrag(rect, 199)).toBe(true)
    expect(isResizeEdgeDrag(rect, 200 - RESIZE_EDGE_PX)).toBe(true)
  })

  it('suppresses a press on the left edge (where the secondary sidebar sash lives)', () => {
    expect(isResizeEdgeDrag(rect, 1)).toBe(true)
    expect(isResizeEdgeDrag(rect, 0 + RESIZE_EDGE_PX)).toBe(true)
  })

  it('allows a normal drag from the row interior', () => {
    expect(isResizeEdgeDrag(rect, 100)).toBe(false)
    expect(isResizeEdgeDrag(rect, 0 + RESIZE_EDGE_PX + 1)).toBe(false)
    expect(isResizeEdgeDrag(rect, 200 - RESIZE_EDGE_PX - 1)).toBe(false)
  })

  it('allows a drag whose coordinate is outside the row (synthetic 0,0 dragstart)', () => {
    expect(isResizeEdgeDrag(el(250, 450), 0)).toBe(false)
    expect(isResizeEdgeDrag(rect, -5)).toBe(false)
    expect(isResizeEdgeDrag(rect, 205)).toBe(false)
  })

  it('never fires for a degenerate / unmeasured rect', () => {
    expect(isResizeEdgeDrag(el(0, 0), 0)).toBe(false)
    expect(isResizeEdgeDrag(el(10, 5), 7)).toBe(false)
  })

  it('never fires without a measurable target', () => {
    expect(isResizeEdgeDrag(null, 5)).toBe(false)
    expect(isResizeEdgeDrag(undefined, 5)).toBe(false)
  })

  it('ignores a non-finite pointer coordinate', () => {
    expect(isResizeEdgeDrag(rect, Number.NaN)).toBe(false)
  })

  it('respects a custom edge width', () => {
    expect(isResizeEdgeDrag(rect, 190, 6)).toBe(false)
    expect(isResizeEdgeDrag(rect, 190, 12)).toBe(true)
  })
})
