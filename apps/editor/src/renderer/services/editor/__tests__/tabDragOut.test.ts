import { describe, expect, it } from 'vitest'
import { decideTabDragOut, isCopyDragOperation, type TabDragOutInput } from '../tabDragOut.js'

const MAIN = { x: 100, y: 100, width: 800, height: 600 }
const AUX = { x: 1000, y: 200, width: 400, height: 300 }

function input(overrides: Partial<TabDragOutInput> = {}): TabDragOutInput {
  return {
    enabled: true,
    consumed: false,
    cancelled: false,
    screenX: 1500,
    screenY: 700,
    windows: [MAIN, AUX],
    ...overrides,
  }
}

describe('decideTabDragOut', () => {
  it('creates a window at the release point when the pointer is outside every window', () => {
    expect(decideTabDragOut(input())).toEqual({
      create: true,
      geometry: { x: 1500, y: 700 },
    })
  })

  it('rounds fractional screen coordinates', () => {
    expect(decideTabDragOut(input({ screenX: 1500.4, screenY: 700.6 }))).toEqual({
      create: true,
      geometry: { x: 1500, y: 701 },
    })
  })

  it('never creates one when the setting is disabled', () => {
    expect(decideTabDragOut(input({ enabled: false }))).toEqual({
      create: false,
      reason: 'disabled',
    })
  })

  it('never creates one after a drop target consumed the gesture', () => {
    expect(decideTabDragOut(input({ consumed: true }))).toEqual({
      create: false,
      reason: 'consumed',
    })
  })

  it('never creates one after Escape cancelled the gesture', () => {
    expect(decideTabDragOut(input({ cancelled: true }))).toEqual({
      create: false,
      reason: 'cancelled',
    })
  })

  it('treats 0,0 and non-finite coordinates as an aborted gesture', () => {
    expect(decideTabDragOut(input({ screenX: 0, screenY: 0 }))).toEqual({
      create: false,
      reason: 'invalid-coordinates',
    })
    expect(decideTabDragOut(input({ screenX: Number.NaN }))).toEqual({
      create: false,
      reason: 'invalid-coordinates',
    })
    expect(decideTabDragOut(input({ screenY: Number.POSITIVE_INFINITY }))).toEqual({
      create: false,
      reason: 'invalid-coordinates',
    })
  })

  it('does not create one when the release is inside any workbench window', () => {
    expect(decideTabDragOut(input({ screenX: 200, screenY: 200 }))).toEqual({
      create: false,
      reason: 'inside-window',
    })
    // The right/bottom edges count as inside (the pointer is on the window).
    expect(decideTabDragOut(input({ screenX: 900, screenY: 700 }))).toEqual({
      create: false,
      reason: 'inside-window',
    })
    expect(decideTabDragOut(input({ screenX: 1100, screenY: 300 }))).toEqual({
      create: false,
      reason: 'inside-window',
    })
  })

  it('creates one when the pointer is only inside the gap between windows', () => {
    // Between MAIN (ends at 900) and AUX (starts at 1000).
    expect(decideTabDragOut(input({ screenX: 950, screenY: 400 }))).toEqual({
      create: true,
      geometry: { x: 950, y: 400 },
    })
  })

  it('honours the disabled flag before any coordinate decision', () => {
    expect(decideTabDragOut(input({ enabled: false, screenX: 0, screenY: 0 }))).toEqual({
      create: false,
      reason: 'disabled',
    })
  })
})

describe('isCopyDragOperation', () => {
  it('uses Ctrl on Windows/Linux', () => {
    expect(isCopyDragOperation({ ctrlKey: true, altKey: false }, false)).toBe(true)
    expect(isCopyDragOperation({ ctrlKey: false, altKey: true }, false)).toBe(false)
  })

  it('uses Alt/Option on macOS', () => {
    expect(isCopyDragOperation({ ctrlKey: false, altKey: true }, true)).toBe(true)
    expect(isCopyDragOperation({ ctrlKey: true, altKey: false }, true)).toBe(false)
  })
})
