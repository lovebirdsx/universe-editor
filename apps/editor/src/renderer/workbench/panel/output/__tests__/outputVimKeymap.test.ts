/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  INITIAL_OUTPUT_VIM_STATE,
  reduceOutputVimKey,
  type OutputVimKeyInput,
  type OutputVimState,
} from '../outputVimKeymap.js'

function key(key: string, mods: Partial<OutputVimKeyInput> = {}): OutputVimKeyInput {
  return {
    key,
    ctrl: false,
    alt: false,
    meta: false,
    shift: false,
    ...mods,
  }
}

function press(state: OutputVimState, ...keys: OutputVimKeyInput[]) {
  let current = state
  let last
  for (const stroke of keys) {
    last = reduceOutputVimKey(current, stroke)
    current = last.state
  }
  return { state: current, command: last?.command ?? null, handled: last?.handled ?? false }
}

describe('reduceOutputVimKey', () => {
  it('moves with j/k and accumulates counts', () => {
    expect(press(INITIAL_OUTPUT_VIM_STATE, key('3'), key('j')).command).toEqual({
      type: 'move',
      direction: 'down',
      count: 3,
    })
    expect(press(INITIAL_OUTPUT_VIM_STATE, key('k')).command).toEqual({
      type: 'move',
      direction: 'up',
      count: 1,
    })
    // Count digits can be separated by any unmapped Vim key only until a motion;
    // `10` is one number, not 1 then 0.
    const ten = press(INITIAL_OUTPUT_VIM_STATE, key('1'), key('0'), key('k'))
    expect(ten.command).toEqual({ type: 'move', direction: 'up', count: 10 })
  })

  it('maps Ctrl+E/Y to viewport scrolling with the count as lines', () => {
    expect(press(INITIAL_OUTPUT_VIM_STATE, key('e', { ctrl: true })).command).toEqual({
      type: 'scroll-viewport',
      direction: 'down',
      count: 1,
    })
    expect(press(INITIAL_OUTPUT_VIM_STATE, key('2'), key('e', { ctrl: true })).command).toEqual({
      type: 'scroll-viewport',
      direction: 'down',
      count: 2,
    })
    expect(press(INITIAL_OUTPUT_VIM_STATE, key('y', { ctrl: true })).command).toEqual({
      type: 'scroll-viewport',
      direction: 'up',
      count: 1,
    })
  })

  it('maps Ctrl+D/U to half pages and Ctrl+F/B to full pages', () => {
    expect(press(INITIAL_OUTPUT_VIM_STATE, key('d', { ctrl: true })).command).toEqual({
      type: 'page',
      direction: 'down',
      fraction: 'half',
      count: 1,
    })
    expect(press(INITIAL_OUTPUT_VIM_STATE, key('u', { ctrl: true })).command).toEqual({
      type: 'page',
      direction: 'up',
      fraction: 'half',
      count: 1,
    })
    expect(press(INITIAL_OUTPUT_VIM_STATE, key('f', { ctrl: true })).command).toEqual({
      type: 'page',
      direction: 'down',
      fraction: 'full',
      count: 1,
    })
    expect(press(INITIAL_OUTPUT_VIM_STATE, key('b', { ctrl: true })).command).toEqual({
      type: 'page',
      direction: 'up',
      fraction: 'full',
      count: 1,
    })
  })

  it('jumps with gg and G, treating a count as the target line', () => {
    expect(press(INITIAL_OUTPUT_VIM_STATE, key('g'), key('g')).command).toEqual({
      type: 'goto',
      target: 'first',
      line: null,
    })
    expect(press(INITIAL_OUTPUT_VIM_STATE, key('G')).command).toEqual({
      type: 'goto',
      target: 'last',
      line: null,
    })
    expect(press(INITIAL_OUTPUT_VIM_STATE, key('4'), key('2'), key('G')).command).toEqual({
      type: 'goto',
      target: 'last',
      line: 42,
    })
    expect(press(INITIAL_OUTPUT_VIM_STATE, key('7'), key('g'), key('g')).command).toEqual({
      type: 'goto',
      target: 'first',
      line: 7,
    })
  })

  it('swallows unmapped printable keys and dangling g, but passes function keys', () => {
    const printable = reduceOutputVimKey(INITIAL_OUTPUT_VIM_STATE, key('d'))
    expect(printable.handled).toBe(true)
    expect(printable.command).toBeNull()
    expect(printable.state).toEqual(INITIAL_OUTPUT_VIM_STATE)

    const dangling = reduceOutputVimKey({ count: 0, pendingG: true }, key('x'))
    expect(dangling.handled).toBe(true)
    expect(dangling.command).toBeNull()

    const f5 = reduceOutputVimKey(INITIAL_OUTPUT_VIM_STATE, key('F5'))
    expect(f5.handled).toBe(false)
    const pageDown = reduceOutputVimKey(INITIAL_OUTPUT_VIM_STATE, key('PageDown'))
    expect(pageDown.handled).toBe(false)

    const danglingF5 = reduceOutputVimKey({ count: 0, pendingG: true }, key('F5'))
    expect(danglingF5.handled).toBe(false)
    expect(danglingF5.state).toEqual(INITIAL_OUTPUT_VIM_STATE)
  })

  it('leaves Escape, Alt/Meta chords and unknown Ctrl chords to Monaco', () => {
    const escape = reduceOutputVimKey({ count: 3, pendingG: false }, key('Escape'))
    expect(escape.handled).toBe(false)
    expect(escape.state).toEqual(INITIAL_OUTPUT_VIM_STATE)

    expect(reduceOutputVimKey(INITIAL_OUTPUT_VIM_STATE, key('j', { alt: true })).handled).toBe(
      false,
    )
    expect(reduceOutputVimKey(INITIAL_OUTPUT_VIM_STATE, key('j', { meta: true })).handled).toBe(
      false,
    )
    expect(reduceOutputVimKey(INITIAL_OUTPUT_VIM_STATE, key('s', { ctrl: true })).handled).toBe(
      false,
    )
    // Ctrl+Shift+E is not the Vim scroll stroke.
    expect(
      reduceOutputVimKey(INITIAL_OUTPUT_VIM_STATE, key('E', { ctrl: true, shift: true })).handled,
    ).toBe(false)
  })

  it('never emits an editing command', () => {
    const inputs = ['i', 'a', 'o', 'd', 'y', 'c', 'p', 'x', '/', '?', ':', 'u', 'r']
    for (const printable of inputs) {
      const result = reduceOutputVimKey(INITIAL_OUTPUT_VIM_STATE, key(printable))
      expect(result.command, printable).toBeNull()
      expect(result.handled, printable).toBe(true)
    }
  })
})
