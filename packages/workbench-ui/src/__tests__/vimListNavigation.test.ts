/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  INITIAL_VIM_LIST_STATE,
  reduceVimListKey,
  type VimListKeyOptions,
  type VimListState,
} from '../keybinding/vimListNavigation.js'

const OPTIONS: VimListKeyOptions = {
  directions: ['up', 'down', 'left', 'right'],
  jumps: true,
  paging: true,
}

function press(
  state: VimListState,
  key: string,
  modifiers: Partial<{ ctrl: boolean; alt: boolean; meta: boolean; shift: boolean }> = {},
  options: VimListKeyOptions = OPTIONS,
) {
  return reduceVimListKey(
    state,
    { key, ctrl: false, alt: false, meta: false, shift: false, ...modifiers },
    options,
  )
}

describe('reduceVimListKey', () => {
  it('maps hjkl to directions', () => {
    expect(press(INITIAL_VIM_LIST_STATE, 'j').motion).toEqual({
      kind: 'direction',
      direction: 'down',
    })
    expect(press(INITIAL_VIM_LIST_STATE, 'k').motion).toEqual({
      kind: 'direction',
      direction: 'up',
    })
    expect(press(INITIAL_VIM_LIST_STATE, 'h').motion).toEqual({
      kind: 'direction',
      direction: 'left',
    })
    expect(press(INITIAL_VIM_LIST_STATE, 'l').motion).toEqual({
      kind: 'direction',
      direction: 'right',
    })
  })

  it('swallows directions the surface does not implement', () => {
    const vertical = press(
      INITIAL_VIM_LIST_STATE,
      'h',
      {},
      {
        ...OPTIONS,
        directions: ['up', 'down'],
      },
    )
    expect(vertical.handled).toBe(true)
    expect(vertical.motion).toBeNull()
  })

  it('swallows digits (lists have no count prefix)', () => {
    expect(press(INITIAL_VIM_LIST_STATE, '3')).toMatchObject({ motion: null, handled: true })
    expect(press(INITIAL_VIM_LIST_STATE, '0')).toMatchObject({ motion: null, handled: true })
  })

  it('resolves gg/G to first/last', () => {
    const firstG = press(INITIAL_VIM_LIST_STATE, 'g')
    expect(firstG.state.pendingG).toBe(true)
    expect(press(firstG.state, 'g').motion).toEqual({ kind: 'first' })
    expect(press(INITIAL_VIM_LIST_STATE, 'G').motion).toEqual({ kind: 'last' })
  })

  it('clears a dangling g on any other key', () => {
    const firstG = press(INITIAL_VIM_LIST_STATE, 'g')
    const result = press(firstG.state, 'x')
    expect(result.state.pendingG).toBe(false)
    expect(result.handled).toBe(true)
    expect(result.motion).toBeNull()
  })

  it('maps Ctrl+d/u to paging', () => {
    expect(press(INITIAL_VIM_LIST_STATE, 'd', { ctrl: true }).motion).toEqual({
      kind: 'page',
      direction: 'down',
    })
    expect(press(INITIAL_VIM_LIST_STATE, 'u', { ctrl: true }).motion).toEqual({
      kind: 'page',
      direction: 'up',
    })
  })

  it('leaves Shift-modified Ctrl strokes to the workbench', () => {
    expect(press(INITIAL_VIM_LIST_STATE, 'D', { ctrl: true, shift: true }).handled).toBe(false)
    expect(press(INITIAL_VIM_LIST_STATE, 'U', { ctrl: true, shift: true }).handled).toBe(false)
  })

  it('leaves non-vim keys to the list', () => {
    expect(press(INITIAL_VIM_LIST_STATE, 'Escape').handled).toBe(false)
    expect(press(INITIAL_VIM_LIST_STATE, 'Enter').handled).toBe(false)
    expect(press(INITIAL_VIM_LIST_STATE, ' ').handled).toBe(false)
    expect(press(INITIAL_VIM_LIST_STATE, 'ArrowDown').handled).toBe(false)
    expect(press(INITIAL_VIM_LIST_STATE, 'c', { ctrl: true }).handled).toBe(false)
    expect(press(INITIAL_VIM_LIST_STATE, 'j', { alt: true }).handled).toBe(false)
  })

  it('swallows unknown printable keys (no typeahead leak)', () => {
    const result = press(INITIAL_VIM_LIST_STATE, 'q')
    expect(result.handled).toBe(true)
    expect(result.motion).toBeNull()
  })

  it('ignores gg/G when jumps are disabled', () => {
    const options: VimListKeyOptions = { ...OPTIONS, jumps: false }
    expect(press(INITIAL_VIM_LIST_STATE, 'g', {}, options).state.pendingG).toBe(false)
    expect(press(INITIAL_VIM_LIST_STATE, 'G', {}, options).motion).toBeNull()
  })
})
