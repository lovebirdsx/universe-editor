/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { isVimPagingStroke, reduceVimKey } from '../vimKeymap.js'
import { INITIAL_VIM_STATE, type VimKeyInput, type VimState } from '../vimTypes.js'

function press(state: VimState, key: string, modifiers: Partial<Omit<VimKeyInput, 'key'>> = {}) {
  return reduceVimKey(state, {
    key,
    ctrl: false,
    alt: false,
    meta: false,
    shift: false,
    repeat: false,
    ...modifiers,
  })
}

describe('reduceVimKey', () => {
  it('maps h/j/k/l to motions', () => {
    for (const key of ['h', 'j', 'k', 'l'] as const) {
      const result = press(INITIAL_VIM_STATE, key)
      expect(result.command).toEqual({ type: 'motion', motion: key, count: 0 })
      expect(result.handled).toBe(true)
    }
  })

  it('accumulates a count prefix', () => {
    const state = press(INITIAL_VIM_STATE, '3').state
    const result = press(state, 'j')
    expect(result.command).toEqual({ type: 'motion', motion: 'j', count: 3 })
  })

  it('treats a leading 0 as line-start and a trailing 0 as a digit', () => {
    expect(press(INITIAL_VIM_STATE, '0').command).toEqual({
      type: 'motion',
      motion: '0',
      count: 0,
    })
    const ten = press(press(INITIAL_VIM_STATE, '1').state, '0')
    expect(ten.state.count).toBe(10)
    expect(ten.command).toBeNull()
  })

  it('treats 0 after an operator as the motion, and a started count as digits', () => {
    const afterOperator = press(press(INITIAL_VIM_STATE, '3').state, 'd').state
    expect(press(afterOperator, '0').command).toEqual({
      type: 'operator',
      operator: 'd',
      motion: '0',
      count: 3,
    })
    const afterOperatorCount = press(press(INITIAL_VIM_STATE, 'd').state, '1').state
    const ten = press(afterOperatorCount, '0')
    expect(ten.state.count).toBe(10)
    expect(ten.command).toBeNull()
  })

  it('maps ^ to the first non-blank motion', () => {
    expect(press(INITIAL_VIM_STATE, '^').command).toEqual({
      type: 'motion',
      motion: '^',
      count: 0,
    })
    expect(press(press(INITIAL_VIM_STATE, 'd').state, '^').command).toEqual({
      type: 'operator',
      operator: 'd',
      motion: '^',
      count: 0,
    })
  })

  it('turns dd/cc/yy into linewise commands', () => {
    for (const key of ['d', 'c', 'y'] as const) {
      const armed = press(INITIAL_VIM_STATE, key)
      expect(armed.state.pendingOperator).toBe(key)
      expect(armed.command).toBeNull()
      const result = press(armed.state, key)
      expect(result.command).toEqual({ type: 'linewise', operator: key, count: 1 })
    }
  })

  it('combines an operator with a motion', () => {
    const armed = press(INITIAL_VIM_STATE, 'd')
    const result = press(armed.state, 'w')
    expect(result.command).toEqual({ type: 'operator', operator: 'd', motion: 'w', count: 0 })
  })

  it('supports counts on operators and motions', () => {
    let state = press(INITIAL_VIM_STATE, '3').state
    state = press(state, 'd').state
    const result = press(state, 'w')
    expect(result.command).toEqual({ type: 'operator', operator: 'd', motion: 'w', count: 3 })
  })

  it('resolves gg and G', () => {
    const firstG = press(INITIAL_VIM_STATE, 'g')
    expect(firstG.state.pendingG).toBe(true)
    expect(press(firstG.state, 'g').command).toEqual({ type: 'motion', motion: 'gg', count: 0 })
    expect(press(INITIAL_VIM_STATE, 'G').command).toEqual({ type: 'motion', motion: 'G', count: 0 })
  })

  it('clears a dangling g when another key arrives', () => {
    const firstG = press(INITIAL_VIM_STATE, 'g')
    const result = press(firstG.state, 'x')
    expect(result.state.pendingG).toBe(false)
    expect(result.command).toBeNull()
    expect(result.handled).toBe(true)
  })

  it('enters insert mode for each placement key', () => {
    const placements = {
      i: 'before',
      a: 'after',
      I: 'line-start',
      A: 'line-end',
      o: 'open-below',
      O: 'open-above',
    } as const
    for (const [key, placement] of Object.entries(placements)) {
      expect(press(INITIAL_VIM_STATE, key).command).toEqual({ type: 'enter-insert', placement })
    }
  })

  it('handles x/X/p/P/u/J', () => {
    expect(press(INITIAL_VIM_STATE, 'x').command).toEqual({
      type: 'delete-char',
      count: 1,
      backward: false,
    })
    expect(press(INITIAL_VIM_STATE, 'X').command).toEqual({
      type: 'delete-char',
      count: 1,
      backward: true,
    })
    expect(press(INITIAL_VIM_STATE, 'p').command).toEqual({
      type: 'paste',
      count: 1,
      before: false,
    })
    expect(press(INITIAL_VIM_STATE, 'P').command).toEqual({
      type: 'paste',
      count: 1,
      before: true,
    })
    expect(press(INITIAL_VIM_STATE, 'u').command).toEqual({ type: 'undo' })
    expect(press(INITIAL_VIM_STATE, 'J').command).toEqual({ type: 'join-lines', count: 1 })
  })

  it('swallows unknown printable keys in normal mode', () => {
    const result = press(INITIAL_VIM_STATE, 'q')
    expect(result.handled).toBe(true)
    expect(result.command).toBeNull()
  })

  it('passes everything except Escape through in insert mode', () => {
    const insert = { ...INITIAL_VIM_STATE, mode: 'insert' as const }
    const typed = press(insert, 'j')
    expect(typed.handled).toBe(false)
    expect(typed.command).toBeNull()
    const escaped = press(insert, 'Escape')
    expect(escaped.state.mode).toBe('normal')
    expect(escaped.handled).toBe(true)
  })

  it('maps Ctrl+f/b/d/u to paging motions', () => {
    expect(press(INITIAL_VIM_STATE, 'f', { ctrl: true }).command).toEqual({
      type: 'motion',
      motion: 'pageDown',
      count: 0,
    })
    expect(press(INITIAL_VIM_STATE, 'b', { ctrl: true }).command).toEqual({
      type: 'motion',
      motion: 'pageUp',
      count: 0,
    })
    expect(press(INITIAL_VIM_STATE, 'd', { ctrl: true }).command).toEqual({
      type: 'motion',
      motion: 'halfPageDown',
      count: 0,
    })
    expect(press(INITIAL_VIM_STATE, 'u', { ctrl: true }).command).toEqual({
      type: 'motion',
      motion: 'halfPageUp',
      count: 0,
    })
  })

  it('leaves unrelated ctrl/alt/meta strokes to the global dispatcher', () => {
    expect(press(INITIAL_VIM_STATE, 'c', { ctrl: true }).handled).toBe(false)
    expect(press(INITIAL_VIM_STATE, 'j', { alt: true }).handled).toBe(false)
    expect(press(INITIAL_VIM_STATE, 'j', { meta: true }).handled).toBe(false)
  })

  it('aborts a pending operator when an unhandled modified stroke arrives', () => {
    const armed = press(INITIAL_VIM_STATE, 'd').state
    const result = press(armed, 's', { ctrl: true })
    expect(result.handled).toBe(false)
    expect(result.state.pendingOperator).toBeNull()
  })
})

describe('isVimPagingStroke', () => {
  it('accepts only plain Ctrl + f/b/d/u', () => {
    expect(isVimPagingStroke({ key: 'f', ctrlKey: true, altKey: false, metaKey: false })).toBe(true)
    expect(
      isVimPagingStroke({ key: 'F', ctrlKey: true, altKey: false, metaKey: false, shiftKey: true }),
    ).toBe(false)
    expect(isVimPagingStroke({ key: 'f', ctrlKey: true, altKey: true, metaKey: false })).toBe(false)
    expect(isVimPagingStroke({ key: 'f', ctrlKey: true, altKey: false, metaKey: true })).toBe(false)
    expect(isVimPagingStroke({ key: 'j', ctrlKey: true, altKey: false, metaKey: false })).toBe(
      false,
    )
    expect(isVimPagingStroke({ key: 'f', ctrlKey: false, altKey: false, metaKey: false })).toBe(
      false,
    )
  })
})
