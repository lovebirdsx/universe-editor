import { describe, expect, it } from 'vitest'
import {
  computePointAnchoredPosition,
  computeSubmenuPosition,
  layout,
  type IAnchorRect,
} from '../overlay/anchorLayout.js'

describe('layout', () => {
  describe("position 'before'", () => {
    it('lays out after the anchor when it fits', () => {
      expect(layout(1000, 200, { offset: 100, size: 50, position: 'before' })).toEqual({
        position: 150,
        result: 'ok',
      })
    })

    it('flips before the anchor when the far side is too tight', () => {
      // 900 + 200 > 1000, but 800 of room before the anchor is plenty.
      expect(layout(1000, 200, { offset: 800, size: 100, position: 'before' })).toEqual({
        position: 600,
        result: 'flipped',
      })
    })

    it('overlaps clamped to the far viewport edge when neither side fits', () => {
      expect(layout(300, 250, { offset: 100, size: 100, position: 'before' })).toEqual({
        position: 50,
        result: 'overlap',
      })
    })

    it('never clamps to a negative position', () => {
      expect(layout(100, 250, { offset: 10, size: 10, position: 'before' })).toEqual({
        position: 0,
        result: 'overlap',
      })
    })
  })

  describe("position 'after'", () => {
    it('lays out before the anchor when it fits', () => {
      expect(layout(1000, 200, { offset: 500, size: 50, position: 'after' })).toEqual({
        position: 300,
        result: 'ok',
      })
    })

    it('flips after the anchor when the near side is much too tight', () => {
      // 50 of room before < 200/2, and 200 fits after the anchor's far edge.
      expect(layout(1000, 200, { offset: 50, size: 50, position: 'after' })).toEqual({
        position: 100,
        result: 'flipped',
      })
    })

    it('overlaps at the near edge rather than flipping into a sliver', () => {
      // 150 of room before is >= 200/2, so the flip guard rejects the far side.
      expect(layout(1000, 200, { offset: 150, size: 50, position: 'after' })).toEqual({
        position: 0,
        result: 'overlap',
      })
    })
  })

  describe("mode 'align'", () => {
    it('starts at the anchor edge instead of clearing the anchor box', () => {
      expect(
        layout(1000, 200, { offset: 100, size: 50, position: 'before', mode: 'align' }),
      ).toEqual({ position: 100, result: 'ok' })
    })

    it('flips against the anchor far edge', () => {
      expect(
        layout(1000, 200, { offset: 850, size: 50, position: 'before', mode: 'align' }),
      ).toEqual({ position: 700, result: 'flipped' })
    })
  })
})

describe('computeSubmenuPosition', () => {
  const viewport = { width: 1000, height: 800 }
  const submenu = { width: 200, height: 300 }

  it('opens to the right of the row, aligned with its top', () => {
    const entry: IAnchorRect = { top: 100, left: 50, width: 160, height: 22 }
    expect(computeSubmenuPosition(viewport, submenu, entry, 'right')).toEqual({
      top: 100,
      left: 210,
      direction: 'right',
    })
  })

  it('flips to the left of the row and reports the flipped direction', () => {
    const entry: IAnchorRect = { top: 100, left: 700, width: 160, height: 22 }
    expect(computeSubmenuPosition(viewport, submenu, entry, 'right')).toEqual({
      top: 100,
      left: 500,
      direction: 'left',
    })
  })

  it('keeps expanding left once the chain has flipped', () => {
    const entry: IAnchorRect = { top: 100, left: 500, width: 160, height: 22 }
    expect(computeSubmenuPosition(viewport, submenu, entry, 'left')).toEqual({
      top: 100,
      left: 300,
      direction: 'left',
    })
  })

  it('nudges 10px right of the row when the panel has to overlap it', () => {
    // 260 wide viewport: 200 fits neither after (100+160) nor before (100).
    const entry: IAnchorRect = { top: 100, left: 100, width: 160, height: 22 }
    const result = computeSubmenuPosition({ width: 320, height: 800 }, submenu, entry, 'right')
    expect(result.left).toBe(110)
    // The row is no longer treated as an obstacle, so the top shifts by 10 too.
    expect(result.top).toBe(110)
  })

  it('clamps the panel inside the viewport when neither side fits vertically', () => {
    const entry: IAnchorRect = { top: 100, left: 50, width: 160, height: 22 }
    expect(
      computeSubmenuPosition(
        { width: 1000, height: 300 },
        { width: 200, height: 250 },
        entry,
        'right',
      ),
    ).toEqual({ top: 50, left: 210, direction: 'right' })
  })

  it("slides down to the row's bottom when the panel flipped upwards", () => {
    // 300 does not fit below top=700, but does fit above it, and the row's own
    // 22px still fits underneath (400 + 22 + 300 <= 800).
    const entry: IAnchorRect = { top: 700, left: 50, width: 160, height: 22 }
    expect(computeSubmenuPosition(viewport, submenu, entry, 'right')).toEqual({
      top: 422,
      left: 210,
      direction: 'right',
    })
  })

  it('flips upwards without sliding when the row height would overflow', () => {
    // 300 fits above top=300 exactly, but 0 + 22 + 300 > 310 so no slide.
    const entry: IAnchorRect = { top: 300, left: 50, width: 160, height: 22 }
    expect(computeSubmenuPosition({ width: 1000, height: 310 }, submenu, entry, 'right')).toEqual({
      top: 0,
      left: 210,
      direction: 'right',
    })
  })

  it('does not mutate the entry rect', () => {
    const entry: IAnchorRect = { top: 100, left: 100, width: 160, height: 22 }
    computeSubmenuPosition({ width: 320, height: 800 }, submenu, entry, 'right')
    expect(entry).toEqual({ top: 100, left: 100, width: 160, height: 22 })
  })

  it('survives an all-zero measurement (happy-dom rects)', () => {
    const zero = { top: 0, left: 0, width: 0, height: 0 }
    expect(
      computeSubmenuPosition({ width: 0, height: 0 }, { width: 0, height: 0 }, zero, 'right'),
    ).toEqual({ top: 0, left: 0, direction: 'right' })
  })
})

describe('computePointAnchoredPosition', () => {
  it('keeps the popup below-right of the point when it fits', () => {
    expect(
      computePointAnchoredPosition(
        { width: 1000, height: 800 },
        { width: 200, height: 300 },
        {
          x: 100,
          y: 100,
        },
      ),
    ).toEqual({ top: 100, left: 100 })
  })

  it('flips up and left near the bottom-right corner', () => {
    expect(
      computePointAnchoredPosition(
        { width: 1000, height: 800 },
        { width: 200, height: 300 },
        {
          x: 950,
          y: 750,
        },
      ),
    ).toEqual({ top: 450, left: 750 })
  })
})
