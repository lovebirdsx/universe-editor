import { describe, expect, it } from 'vitest'
import {
  DOUBLE_TAP_SCALE,
  IDENTITY_TRANSFORM,
  clampImageScale,
  isDoubleTap,
  movedBeyondTolerance,
  panImage,
  shouldDismissByDrag,
  toggleDoubleTap,
  zoomAround,
} from '../imageGesture.js'

describe('clampImageScale', () => {
  it('keeps the scale within fit..4 and recovers from NaN', () => {
    expect(clampImageScale(0.2)).toBe(1)
    expect(clampImageScale(2)).toBe(2)
    expect(clampImageScale(9)).toBe(4)
    expect(clampImageScale(Number.NaN)).toBe(1)
  })
})

describe('zoomAround', () => {
  it('keeps the content under the anchor fixed', () => {
    const next = zoomAround(IDENTITY_TRANSFORM, 2, 30, -20)
    // The content point under (30,-20) maps back to the same screen offset.
    const contentX = (30 - next.x) / next.scale
    const contentY = (-20 - next.y) / next.scale
    expect(30 - next.x).toBeCloseTo(contentX * 2)
    expect(-20 - next.y).toBeCloseTo(contentY * 2)
    expect(next.scale).toBe(2)
  })

  it('applies the new scale so the inverse mapping is stable', () => {
    const current = { scale: 2, x: 10, y: -10 }
    const next = zoomAround(current, 3, 50, 40)
    const beforeX = (50 - current.x) / current.scale
    const beforeY = (40 - current.y) / current.scale
    expect((50 - next.x) / next.scale).toBeCloseTo(beforeX)
    expect((40 - next.y) / next.scale).toBeCloseTo(beforeY)
  })
})

describe('panImage', () => {
  it('clamps translation to the scaled overflow', () => {
    const zoomed = { scale: 2, x: 0, y: 0 }
    const viewport = { width: 400, height: 800 }
    expect(panImage(zoomed, 10, 10, viewport)).toEqual({ scale: 2, x: 10, y: 10 })
    expect(panImage(zoomed, 1000, -1000, viewport)).toEqual({
      scale: 2,
      x: 200,
      y: -400,
    })
  })

  it('does not pan at fit scale', () => {
    expect(panImage(IDENTITY_TRANSFORM, 50, 50, { width: 400, height: 800 })).toEqual(
      IDENTITY_TRANSFORM,
    )
  })
})

describe('toggleDoubleTap', () => {
  it('zooms to 2x around the tap, then resets', () => {
    const zoomed = toggleDoubleTap(IDENTITY_TRANSFORM, 40, 20)
    expect(zoomed.scale).toBe(DOUBLE_TAP_SCALE)
    expect(toggleDoubleTap(zoomed, 40, 20)).toEqual(IDENTITY_TRANSFORM)
  })
})

describe('gesture thresholds', () => {
  it('dismisses only after the drag threshold', () => {
    expect(shouldDismissByDrag(119)).toBe(false)
    expect(shouldDismissByDrag(120)).toBe(true)
  })

  it('detects double taps within the time and distance window', () => {
    expect(isDoubleTap(undefined, 100)).toBe(false)
    expect(isDoubleTap(80, 200)).toBe(true)
    expect(isDoubleTap(80, 500)).toBe(false)
    expect(isDoubleTap(80, 200, { x: 0, y: 0 }, { x: 10, y: 10 })).toBe(true)
    expect(isDoubleTap(80, 200, { x: 0, y: 0 }, { x: 100, y: 0 })).toBe(false)
  })

  it('ignores sub-tolerance jitter while still counting real movement', () => {
    expect(movedBeyondTolerance({ x: 10, y: 10 }, { x: 12, y: 11 })).toBe(false)
    expect(movedBeyondTolerance({ x: 10, y: 10 }, { x: 20, y: 10 })).toBe(true)
  })
})
