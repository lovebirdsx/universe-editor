/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Sequence engine: counts, multi-token prefixes, ambiguity timeout, Esc.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { VimSequenceEngine } from '../keybinding/vim/vimSequence.js'
import type { IVimKeymapEntry } from '../keybinding/vim/vimTypes.js'

const entries: readonly IVimKeymapEntry[] = [
  { id: 'down', keys: ['j'], command: 'list.focusDown' },
  { id: 'first', keys: ['g', 'g'], command: 'list.focusFirst' },
  { id: 'last', keys: ['G'], command: 'list.focusLast' },
  { id: 'toggle', keys: ['z', 'a'], command: 'list.toggle' },
  { id: 'z', keys: ['z'], command: 'z.command' },
  { id: 'leader', keys: ['<leader>', 'e'], command: 'workbench.view.explorer' },
]

function engine(): VimSequenceEngine {
  return new VimSequenceEngine(entries)
}

describe('VimSequenceEngine', () => {
  it('executes a single-token command and resets', () => {
    const e = engine()
    expect(e.feed('j')).toEqual({ kind: 'execute', matches: [entries[0]], count: 0 })
    expect(e.isPending).toBe(false)
  })

  it('collects a count before the command', () => {
    const e = engine()
    expect(e.feed('2')).toEqual({ kind: 'pending', count: 2, prefix: [] })
    const result = e.feed('j')
    expect(result).toMatchObject({ kind: 'execute', count: 2 })
  })

  it('extends a count with a trailing zero', () => {
    const e = engine()
    e.feed('1')
    expect(e.feed('0')).toEqual({ kind: 'pending', count: 10, prefix: [] })
    expect(e.feed('j')).toMatchObject({ kind: 'execute', count: 10 })
  })

  it('treats a bare 0 as a normal token, not a count', () => {
    const e = engine()
    expect(e.feed('0')).toEqual({ kind: 'none' })
  })

  it('waits for the second token of gg', () => {
    const e = engine()
    expect(e.feed('g')).toMatchObject({ kind: 'pending', prefix: ['g'] })
    expect(e.feed('g')).toMatchObject({ kind: 'execute', matches: [entries[1]], count: 0 })
  })

  it('keeps a count across a multi-token prefix', () => {
    const e = engine()
    e.feed('3')
    e.feed('g')
    expect(e.feed('g')).toMatchObject({ kind: 'execute', count: 3 })
  })

  it('cancels a pending prefix on Esc', () => {
    const e = engine()
    e.feed('g')
    expect(e.feed('escape')).toEqual({ kind: 'cancel' })
    expect(e.isPending).toBe(false)
  })

  it('swallows Esc only while something is pending', () => {
    const e = engine()
    expect(e.feed('escape')).toEqual({ kind: 'none' })
  })

  it('aborts an unmatched prefix and reports the token as unowned', () => {
    const e = engine()
    e.feed('g')
    expect(e.feed('j')).toEqual({ kind: 'none' })
    expect(e.isPending).toBe(false)
  })

  it('waits for the timeout when a command is also a longer prefix', () => {
    const e = engine()
    expect(e.feed('z')).toMatchObject({ kind: 'pending', prefix: ['z'] })
    expect(e.flush()).toMatchObject({ kind: 'execute', matches: [entries[4]], count: 0 })
  })

  it('prefers the longer prefix when the next token continues it', () => {
    const e = engine()
    e.feed('z')
    expect(e.feed('a')).toMatchObject({ kind: 'execute', matches: [entries[3]] })
  })

  it('fires the complete command when the next token breaks the longer prefix', () => {
    const e = engine()
    e.feed('z')
    expect(e.feed('q')).toMatchObject({ kind: 'execute', matches: [entries[4]] })
  })

  it('flushes an incomplete prefix as a no-op cancel', () => {
    const e = engine()
    e.feed('g')
    expect(e.flush()).toEqual({ kind: 'cancel' })
    expect(e.isPending).toBe(false)
  })

  it('supports leader sequences from replacement tokens', () => {
    const e = new VimSequenceEngine([
      { id: 'leader.e', keys: ['space', 'e'], command: 'workbench.view.explorer' },
    ])
    expect(e.feed('space')).toMatchObject({ kind: 'pending', prefix: ['space'] })
    expect(e.feed('e')).toMatchObject({ kind: 'execute' })
  })

  it('lets the keymap change without dropping the pending count', () => {
    const e = engine()
    e.feed('4')
    e.setEntries([{ id: 'x', keys: ['x'], command: 'x' }])
    expect(e.feed('x')).toMatchObject({ kind: 'execute', count: 4 })
  })
})
