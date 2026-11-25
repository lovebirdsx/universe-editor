/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { reduceVimKey } from '../vimKeymap.js'
import { computeVimPendingHint } from '../vimPendingHints.js'
import { INITIAL_VIM_STATE, type VimKeyInput, type VimState } from '../vimTypes.js'

function press(state: VimState, key: string): VimState {
  const input: VimKeyInput = { key, ctrl: false, alt: false, meta: false, shift: false }
  return reduceVimKey(state, input).state
}

function after(keys: string): VimState {
  let state = INITIAL_VIM_STATE
  for (const key of keys) state = press(state, key)
  return state
}

function keysOf(state: VimState): string[] {
  return computeVimPendingHint(state)?.items.map((item) => item.key) ?? []
}

describe('computeVimPendingHint', () => {
  it('has nothing to list while idle, in Insert, or for a bare count / register / char argument', () => {
    expect(computeVimPendingHint(INITIAL_VIM_STATE)).toBeUndefined()
    expect(computeVimPendingHint({ ...INITIAL_VIM_STATE, mode: 'insert' })).toBeUndefined()
    expect(computeVimPendingHint(after('3'))).toBeUndefined()
    expect(computeVimPendingHint(after('"a'))).toBeUndefined()
    expect(computeVimPendingHint(after('f'))).toBeUndefined()
    expect(computeVimPendingHint(after('r'))).toBeUndefined()
  })

  it('lists the whole Normal g table with registry descriptions', () => {
    const hint = computeVimPendingHint(after('g'))
    expect(hint?.prefix).toBe('g')
    expect(hint?.items).toHaveLength(16)
    expect(hint?.items.find((item) => item.key === 'g')?.title).toBe('First line (or line N)')
    expect(hint?.items.find((item) => item.key === '~')?.title).toBe('Toggle case')
    expect(hint?.items.find((item) => item.key === 'h')?.title).toBe('Show hover')
  })

  it('keeps the count in the prefix', () => {
    expect(computeVimPendingHint(after('2g'))?.prefix).toBe('2g')
  })

  it('lists z and the bracket tables', () => {
    const z = computeVimPendingHint(after('z'))
    expect(z?.items).toHaveLength(13)
    expect(z?.items[0]).toEqual({
      key: 'z',
      title: 'Center the cursor line in the window',
      isGroup: false,
    })
    const next = computeVimPendingHint(after(']'))
    expect(next?.items.map((item) => item.key)).toEqual(['d', 'c', 'z'])
    expect(next?.items[0]?.title).toBe('Next diagnostic')
    const previous = computeVimPendingHint(after('['))
    expect(previous?.items[0]?.title).toBe('Previous diagnostic')
  })

  it('uses the Visual actions for g, without the Normal-only operators', () => {
    const hint = computeVimPendingHint(after('vg'))
    expect(hint?.prefix).toBe('g')
    const keys = hint?.items.map((item) => item.key) ?? []
    expect(keys).toEqual([...new Set(keys)])
    expect(keys).toHaveLength(16)
    expect(hint?.items.find((item) => item.key === 'J')?.title).toBe(
      'Join the selected lines without spaces',
    )
    expect(hint?.items.find((item) => item.key === 'u')?.title).toBe('Lowercase the selection')
    expect(hint?.items.find((item) => item.key === 'U')?.title).toBe('Uppercase the selection')
  })

  it('lists a linewise repeat, text-object groups, motions and the g group after an operator', () => {
    const hint = computeVimPendingHint(after('d'))
    expect(hint?.prefix).toBe('d')
    expect(hint?.items[0]).toEqual({ key: 'd', title: 'Delete (whole line)', isGroup: false })
    expect(hint?.items.find((item) => item.key === 'i')).toEqual({
      key: 'i',
      title: 'Inner text object',
      isGroup: true,
    })
    expect(hint?.items.find((item) => item.key === 'a')).toEqual({
      key: 'a',
      title: 'Around text object',
      isGroup: true,
    })
    expect(hint?.items.find((item) => item.key === 'w')?.title).toBe('Next word')
    expect(hint?.items.find((item) => item.key === 'g')).toEqual({
      key: 'g',
      title: '+3',
      isGroup: true,
    })
    // `z` is rejected after an operator; the bracket commands would drop it silently.
    const keys = keysOf(after('d'))
    expect(keys).not.toContain('z')
    expect(keys).not.toContain('[')
    expect(keys).not.toContain(']')
    expect(computeVimPendingHint(after('2d'))?.prefix).toBe('2d')
  })

  it('only keeps motions inside g while an operator is pending', () => {
    const hint = computeVimPendingHint(after('dg'))
    expect(hint?.prefix).toBe('dg')
    expect(hint?.items.map((item) => item.key)).toEqual(['g', 'j', 'k'])
    expect(hint?.items[0]?.title).toBe('First line (or line N)')
  })

  it('keeps the current g operator as a linewise repeat', () => {
    const hint = computeVimPendingHint(after('g~g'))
    expect(hint?.prefix).toBe('g~g')
    expect(hint?.items.find((item) => item.key === '~')).toEqual({
      key: '~',
      title: 'Toggle case (whole line)',
      isGroup: false,
    })
    expect(hint?.items.map((item) => item.key)).not.toContain('u')
  })

  it('lists every text-object alias with the cheat-sheet wording', () => {
    const inner = computeVimPendingHint(after('di'))
    expect(inner?.prefix).toBe('di')
    expect(inner?.items).toHaveLength(17)
    expect(inner?.items.find((item) => item.key === 'w')?.title).toBe('Inner word')
    expect(inner?.items.find((item) => item.key === '(')?.title).toBe('Inner parenthesis block')
    expect(inner?.items.find((item) => item.key === 'b')?.title).toBe('Inner parenthesis block')
    const around = computeVimPendingHint(after('da'))
    expect(around?.items.find((item) => item.key === 'w')?.title).toBe('Around word')
  })

  it('names the linewise form after > and <', () => {
    expect(computeVimPendingHint(after('>'))?.items[0]).toEqual({
      key: '>',
      title: 'Indent (whole line)',
      isGroup: false,
    })
    expect(computeVimPendingHint(after('<'))?.items[0]?.title).toBe('Outdent (whole line)')
  })
})
