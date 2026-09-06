/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for listKeyboard — the index arithmetic shared by Tree and
 *  useFlatListNavigation.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { LIST_PAGE_STEP, resolveIndexNavigation } from '../list/listKeyboard.js'

describe('resolveIndexNavigation', () => {
  it('returns undefined for keys it does not own', () => {
    for (const key of ['Enter', ' ', 'Delete', 'F2', 'a', 'ArrowLeft', 'ArrowRight', 'Tab']) {
      expect(resolveIndexNavigation(key, { index: 0, count: 5 })).toBeUndefined()
    }
  })

  it('returns undefined for an empty list', () => {
    for (const key of ['ArrowDown', 'ArrowUp', 'Home', 'End', 'PageDown', 'PageUp']) {
      expect(resolveIndexNavigation(key, { index: -1, count: 0 })).toBeUndefined()
    }
  })

  it('lands on row 0 from an unfocused list rather than skipping it', () => {
    expect(resolveIndexNavigation('ArrowDown', { index: -1, count: 5 })).toBe(0)
    expect(resolveIndexNavigation('ArrowUp', { index: -1, count: 5 })).toBe(0)
  })

  it('moves by one and clamps at both ends', () => {
    expect(resolveIndexNavigation('ArrowDown', { index: 0, count: 5 })).toBe(1)
    expect(resolveIndexNavigation('ArrowDown', { index: 4, count: 5 })).toBe(4)
    expect(resolveIndexNavigation('ArrowUp', { index: 3, count: 5 })).toBe(2)
    expect(resolveIndexNavigation('ArrowUp', { index: 0, count: 5 })).toBe(0)
  })

  it('jumps to the ends with Home/End regardless of focus', () => {
    expect(resolveIndexNavigation('Home', { index: 3, count: 5 })).toBe(0)
    expect(resolveIndexNavigation('Home', { index: -1, count: 5 })).toBe(0)
    expect(resolveIndexNavigation('End', { index: 0, count: 5 })).toBe(4)
    expect(resolveIndexNavigation('End', { index: -1, count: 5 })).toBe(4)
    expect(resolveIndexNavigation('End', { index: 0, count: 1 })).toBe(0)
  })

  it('pages by LIST_PAGE_STEP by default and clamps', () => {
    expect(resolveIndexNavigation('PageDown', { index: 0, count: 100 })).toBe(LIST_PAGE_STEP)
    expect(resolveIndexNavigation('PageUp', { index: 25, count: 100 })).toBe(25 - LIST_PAGE_STEP)
    expect(resolveIndexNavigation('PageDown', { index: 95, count: 100 })).toBe(99)
    expect(resolveIndexNavigation('PageUp', { index: 3, count: 100 })).toBe(0)
  })

  it('honours an explicit pageSize and never pages by less than one row', () => {
    expect(resolveIndexNavigation('PageDown', { index: 0, count: 100, pageSize: 25 })).toBe(25)
    expect(resolveIndexNavigation('PageUp', { index: 40, count: 100, pageSize: 25 })).toBe(15)
    // A collapsed viewport must still advance rather than stall on the row.
    expect(resolveIndexNavigation('PageDown', { index: 0, count: 100, pageSize: 0 })).toBe(1)
    expect(resolveIndexNavigation('PageDown', { index: 0, count: 100, pageSize: -5 })).toBe(1)
  })

  it('pages from the top when nothing is focused', () => {
    expect(resolveIndexNavigation('PageDown', { index: -1, count: 100 })).toBe(LIST_PAGE_STEP)
    expect(resolveIndexNavigation('PageUp', { index: -1, count: 100 })).toBe(0)
  })
})
