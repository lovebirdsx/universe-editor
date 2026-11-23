/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import {
  createIndexListVimActions,
  createStripVimActions,
  resolveVimGotoIndex,
} from '../keybinding/vimIndexActions.js'
import { LIST_PAGE_STEP } from '../list/listKeyboard.js'

describe('resolveVimGotoIndex', () => {
  it('uses the edge without a count (0) and the 1-based count otherwise', () => {
    expect(resolveVimGotoIndex('first', 0, 10)).toBe(0)
    expect(resolveVimGotoIndex('last', 0, 10)).toBe(9)
    // `1G` is item 1, not the last item
    expect(resolveVimGotoIndex('last', 1, 10)).toBe(0)
    expect(resolveVimGotoIndex('first', 1, 10)).toBe(0)
    expect(resolveVimGotoIndex('first', 5, 10)).toBe(4)
    expect(resolveVimGotoIndex('last', 5, 10)).toBe(4)
  })

  it('clamps an oversized count and reports empty lists', () => {
    expect(resolveVimGotoIndex('first', 99, 10)).toBe(9)
    expect(resolveVimGotoIndex('last', 99, 10)).toBe(9)
    expect(resolveVimGotoIndex('first', 3, 0)).toBe(-1)
    expect(resolveVimGotoIndex('last', 0, 0)).toBe(-1)
  })
})

function makeList(total: number, start = -1, extra: { pageSize?: number } = {}) {
  let index = start
  const setIndex = vi.fn((next: number) => {
    index = next
  })
  const actions = createIndexListVimActions({
    getCount: () => total,
    getIndex: () => index,
    setIndex,
    ...(extra.pageSize !== undefined ? { getPageSize: () => extra.pageSize! } : {}),
  })
  return { actions, setIndex, current: () => index }
}

describe('createIndexListVimActions', () => {
  it('moves with counts and clamps at both ends', () => {
    const { actions, current } = makeList(10, 2)
    actions.move('down', 3)
    expect(current()).toBe(5)
    actions.move('up', 99)
    expect(current()).toBe(0)
    actions.move('down', 99)
    expect(current()).toBe(9)
  })

  it('starts from the top for j and k when nothing is focused', () => {
    const down = makeList(10)
    down.actions.move('down', 1)
    expect(down.current()).toBe(0)
    const down3 = makeList(10)
    down3.actions.move('down', 3)
    expect(down3.current()).toBe(2)
    const up = makeList(10)
    up.actions.move('up', 1)
    expect(up.current()).toBe(0)
  })

  it('can start k from the bottom when asked', () => {
    let index = -1
    const actions = createIndexListVimActions({
      getCount: () => 10,
      getIndex: () => index,
      setIndex: (next) => {
        index = next
      },
      upFromNone: 'last',
    })
    actions.move('up', 1)
    expect(index).toBe(9)
  })

  it('leaves horizontal movement to the host', () => {
    const { actions, setIndex } = makeList(10, 3)
    actions.move('left', 1)
    actions.move('right', 1)
    expect(setIndex).not.toHaveBeenCalled()
  })

  it('treats the count on first / last as the 1-based target', () => {
    const { actions, current } = makeList(10, 0)
    actions.last(0)
    expect(current()).toBe(9)
    actions.first(0)
    expect(current()).toBe(0)
    actions.first(5)
    expect(current()).toBe(4)
    actions.last(3)
    expect(current()).toBe(2)
    actions.last(99)
    expect(current()).toBe(9)
  })

  it('pages by the shared step times the count and clamps', () => {
    const { actions, current } = makeList(100, 0)
    actions.page('down', 1)
    expect(current()).toBe(LIST_PAGE_STEP)
    actions.page('down', 2)
    expect(current()).toBe(LIST_PAGE_STEP * 3)
    actions.page('up', 99)
    expect(current()).toBe(0)
  })

  it('honours a host page size', () => {
    const { actions, current } = makeList(100, 0, { pageSize: 4 })
    actions.page('down', 2)
    expect(current()).toBe(8)
  })

  it('does nothing on an empty list', () => {
    const { actions, setIndex } = makeList(0)
    actions.move('down', 1)
    actions.first(0)
    actions.last(0)
    actions.page('down', 1)
    expect(setIndex).not.toHaveBeenCalled()
  })

  it('adds scrollViewport only when a scroller is supplied', () => {
    expect(makeList(5).actions.scrollViewport).toBeUndefined()
    const scroller = document.createElement('div')
    scroller.scrollTop = 100
    const actions = createIndexListVimActions({
      getCount: () => 5,
      getIndex: () => 0,
      setIndex: () => {},
      scroller: { getElement: () => scroller, getRowHeight: () => 20 },
    })
    actions.scrollViewport?.('down', 2)
    expect(scroller.scrollTop).toBe(140)
    actions.scrollViewport?.('up', 1)
    expect(scroller.scrollTop).toBe(120)
  })
})

function makeStrip(total: number, start: number, wrap = false) {
  let index = start
  const actions = createStripVimActions({
    getCount: () => total,
    getIndex: () => index,
    setIndex: (next) => {
      index = next
    },
    wrap,
  })
  return { actions, current: () => index }
}

describe('createStripVimActions', () => {
  it('clamps next / previous / move by default', () => {
    const { actions, current } = makeStrip(5, 1)
    actions.next(2)
    expect(current()).toBe(3)
    actions.next(9)
    expect(current()).toBe(4)
    actions.previous(9)
    expect(current()).toBe(0)
    actions.move('right', 2)
    expect(current()).toBe(2)
    actions.move('up', 1)
    expect(current()).toBe(1)
  })

  it('wraps around the ends when asked', () => {
    const { actions, current } = makeStrip(4, 3, true)
    actions.next(1)
    expect(current()).toBe(0)
    actions.previous(1)
    expect(current()).toBe(3)
    actions.move('left', 6)
    expect(current()).toBe(1)
  })

  it('lands on the first item without a cursor, or the last one when wrapping backwards', () => {
    const clamped = makeStrip(4, -1)
    clamped.actions.previous(1)
    expect(clamped.current()).toBe(0)
    const wrapped = makeStrip(4, -1, true)
    wrapped.actions.previous(1)
    expect(wrapped.current()).toBe(3)
    const forward = makeStrip(4, -1, true)
    forward.actions.next(1)
    expect(forward.current()).toBe(0)
  })

  it('does not cycle a single item but still jumps to it', () => {
    const { actions, current } = makeStrip(1, 0, true)
    actions.next(1)
    expect(current()).toBe(0)
    actions.first(0)
    expect(current()).toBe(0)
  })

  it('treats the count on first / last as the 1-based target', () => {
    const { actions, current } = makeStrip(6, 0)
    actions.last(0)
    expect(current()).toBe(5)
    actions.first(0)
    expect(current()).toBe(0)
    actions.first(4)
    expect(current()).toBe(3)
    actions.last(2)
    expect(current()).toBe(1)
    actions.last(99)
    expect(current()).toBe(5)
  })

  it('does nothing without items', () => {
    const setIndex = vi.fn()
    const actions = createStripVimActions({ getCount: () => 0, getIndex: () => -1, setIndex })
    actions.next(1)
    actions.first(0)
    actions.last(0)
    expect(setIndex).not.toHaveBeenCalled()
  })
})
