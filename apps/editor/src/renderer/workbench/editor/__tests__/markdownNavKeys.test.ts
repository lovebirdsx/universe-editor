/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  INITIAL_NAV_STATE,
  reduceNavKey,
  type NavCommand,
  type NavKeyState,
} from '../markdownNavKeys.js'

/** Feed a sequence of keys, returning the commands produced and final state. */
function run(keys: Array<string | [string, boolean]>): {
  commands: NavCommand[]
  state: NavKeyState
} {
  let state = INITIAL_NAV_STATE
  const commands: NavCommand[] = []
  for (const k of keys) {
    const [key, shift] = Array.isArray(k) ? k : [k, false]
    const r = reduceNavKey(state, key, shift)
    state = r.state
    if (r.command) commands.push(r.command)
  }
  return { commands, state }
}

describe('reduceNavKey', () => {
  it('maps single scroll keys with default count 1', () => {
    expect(run(['j']).commands).toEqual([{ type: 'scrollLine', dir: 1, count: 1 }])
    expect(run(['k']).commands).toEqual([{ type: 'scrollLine', dir: -1, count: 1 }])
    expect(run(['h']).commands).toEqual([{ type: 'scrollHoriz', dir: -1, count: 1 }])
    expect(run(['l']).commands).toEqual([{ type: 'scrollHoriz', dir: 1, count: 1 }])
    expect(run(['d']).commands).toEqual([{ type: 'scrollHalfPage', dir: 1, count: 1 }])
    expect(run(['u']).commands).toEqual([{ type: 'scrollHalfPage', dir: -1, count: 1 }])
    expect(run(['G']).commands).toEqual([{ type: 'scrollToBottom' }])
  })

  it('treats Space / Shift+Space as full-page down / up', () => {
    expect(run([' ']).commands).toEqual([{ type: 'scrollFullPage', dir: 1 }])
    expect(run([[' ', true]]).commands).toEqual([{ type: 'scrollFullPage', dir: -1 }])
  })

  it('maps history keys H / L', () => {
    expect(run(['H']).commands).toEqual([{ type: 'goBack' }])
    expect(run(['L']).commands).toEqual([{ type: 'goForward' }])
  })

  it('toggles help on ?', () => {
    expect(run(['?']).commands).toEqual([{ type: 'toggleHelp' }])
  })

  it('resolves gg to scroll-to-top', () => {
    expect(run(['g', 'g']).commands).toEqual([{ type: 'scrollToTop' }])
  })

  it('does not fire on a lone g (waits for the chord)', () => {
    const { commands, state } = run(['g'])
    expect(commands).toEqual([])
    expect(state.pendingG).toBe(true)
  })

  it('aborts a pending g and re-interprets the next key', () => {
    // `gj` should scroll down once, not get stuck.
    expect(run(['g', 'j']).commands).toEqual([{ type: 'scrollLine', dir: 1, count: 1 }])
  })

  it('applies a numeric count prefix', () => {
    expect(run(['3', 'j']).commands).toEqual([{ type: 'scrollLine', dir: 1, count: 3 }])
    expect(run(['2', '5', 'k']).commands).toEqual([{ type: 'scrollLine', dir: -1, count: 25 }])
    expect(run(['1', '0', 'd']).commands).toEqual([{ type: 'scrollHalfPage', dir: 1, count: 10 }])
  })

  it('ignores a leading zero as a count prefix', () => {
    const r = reduceNavKey(INITIAL_NAV_STATE, '0', false)
    expect(r.handled).toBe(false)
    expect(r.state).toEqual(INITIAL_NAV_STATE)
  })

  it('accepts 0 after a non-zero prefix digit', () => {
    expect(run(['1', '0', 'j']).commands).toEqual([{ type: 'scrollLine', dir: 1, count: 10 }])
  })

  it('carries the count through the gg chord', () => {
    // gg ignores count (scroll to absolute top); just verify it still resolves.
    expect(run(['5', 'g', 'g']).commands).toEqual([{ type: 'scrollToTop' }])
  })

  it('resets the count after a command completes', () => {
    const { commands } = run(['3', 'j', 'j'])
    expect(commands).toEqual([
      { type: 'scrollLine', dir: 1, count: 3 },
      { type: 'scrollLine', dir: 1, count: 1 },
    ])
  })

  it('drops a dangling count on an unhandled key', () => {
    const { commands, state } = run(['3', 'x'])
    expect(commands).toEqual([])
    expect(state).toEqual(INITIAL_NAV_STATE)
  })

  it('reports handled for consumed keys and not for others', () => {
    expect(reduceNavKey(INITIAL_NAV_STATE, 'j', false).handled).toBe(true)
    expect(reduceNavKey(INITIAL_NAV_STATE, '3', false).handled).toBe(true)
    expect(reduceNavKey(INITIAL_NAV_STATE, 'x', false).handled).toBe(false)
  })
})
