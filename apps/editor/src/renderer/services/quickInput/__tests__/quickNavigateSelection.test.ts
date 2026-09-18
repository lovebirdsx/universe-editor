import { describe, expect, it } from 'vitest'
import { computeInitialSelectionIndex } from '../quickNavigateSelection.js'

const ITEMS = [
  { id: 'a', label: 'a' },
  { id: 'b', label: 'b' },
  { id: 'c', label: 'c' },
]

describe('computeInitialSelectionIndex', () => {
  it('highlights the entry after the current one', () => {
    expect(computeInitialSelectionIndex(ITEMS, 'a', false)).toBe(1)
    expect(computeInitialSelectionIndex(ITEMS, 'b', false)).toBe(2)
  })

  it('reverse direction highlights the entry before the current one, wrapping', () => {
    expect(computeInitialSelectionIndex(ITEMS, 'b', true)).toBe(0)
    expect(computeInitialSelectionIndex(ITEMS, 'a', true)).toBe(2)
  })

  it('falls back to "index 0 is here" when the current target is not listed', () => {
    // Focus parked on the activity bar / status bar: nothing in the list matches.
    expect(computeInitialSelectionIndex(ITEMS, undefined, false)).toBe(1)
    expect(computeInitialSelectionIndex(ITEMS, 'missing', false)).toBe(1)
    expect(computeInitialSelectionIndex(ITEMS, undefined, true)).toBe(2)
  })

  it('does not divide by zero on an empty list', () => {
    expect(computeInitialSelectionIndex([], undefined, false)).toBe(0)
  })
})
