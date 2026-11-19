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

  it('turns dd/yy into linewise commands', () => {
    for (const key of ['d', 'y'] as const) {
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

  it('enters insert mode through i/a/I/A', () => {
    const placements = {
      i: 'before',
      a: 'after',
      I: 'line-start',
      A: 'line-end',
    } as const
    for (const [key, placement] of Object.entries(placements)) {
      expect(press(INITIAL_VIM_STATE, key).command).toEqual({ type: 'enter-insert', placement })
    }
  })

  it('maps o/O/s/S/C to their commands', () => {
    expect(press(INITIAL_VIM_STATE, 'o').command).toEqual({
      type: 'enter-insert',
      placement: 'new-line-below',
    })
    expect(press(INITIAL_VIM_STATE, 'O').command).toEqual({
      type: 'enter-insert',
      placement: 'new-line-above',
    })
    expect(press(INITIAL_VIM_STATE, 's').command).toEqual({ type: 'substitute-char', count: 1 })
    expect(press(INITIAL_VIM_STATE, 'S').command).toEqual({
      type: 'linewise',
      operator: 'c',
      count: 1,
    })
    expect(press(INITIAL_VIM_STATE, 'C').command).toEqual({
      type: 'operator',
      operator: 'c',
      motion: '$',
      count: 1,
    })
  })

  it('treats c as an operator', () => {
    const result = press(INITIAL_VIM_STATE, 'c')
    expect(result.state.pendingOperator).toBe('c')
    expect(result.command).toBeNull()
    expect(press(result.state, 'c').command).toEqual({
      type: 'linewise',
      operator: 'c',
      count: 1,
    })
    expect(press(result.state, 'w').command).toEqual({
      type: 'operator',
      operator: 'c',
      motion: 'w',
      count: 0,
    })
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
    // Emoji is a surrogate pair (`length === 2`) but still text, not a key name.
    for (const key of ['q', ' ', 'й', '😀']) {
      const result = press(INITIAL_VIM_STATE, key)
      expect(result.handled).toBe(true)
      expect(result.command).toBeNull()
    }
  })

  it('maps navigation keys to their Vim equivalents instead of swallowing them', () => {
    const cases = [
      ['ArrowLeft', 'h'],
      ['ArrowRight', 'l'],
      ['ArrowUp', 'k'],
      ['ArrowDown', 'j'],
      ['Home', '0'],
      ['End', '$'],
      ['PageUp', 'pageUp'],
      ['PageDown', 'pageDown'],
      ['Backspace', 'h'],
    ] as const
    for (const [key, motion] of cases) {
      const result = press(INITIAL_VIM_STATE, key)
      expect(result.command).toEqual({ type: 'motion', motion, count: 0 })
      expect(result.handled).toBe(true)
    }
  })

  it('lets counts and operators combine with navigation keys', () => {
    const three = press(INITIAL_VIM_STATE, '3').state
    expect(press(three, 'ArrowDown').command).toEqual({
      type: 'motion',
      motion: 'j',
      count: 3,
    })
    expect(press(press(INITIAL_VIM_STATE, 'd').state, 'ArrowDown').command).toEqual({
      type: 'operator',
      operator: 'd',
      motion: 'j',
      count: 0,
    })
  })

  it('maps Enter to <CR> and Delete to x', () => {
    expect(press(INITIAL_VIM_STATE, 'Enter').command).toEqual({
      type: 'motion',
      motion: 'enter',
      count: 0,
    })
    expect(press(INITIAL_VIM_STATE, 'Delete').command).toEqual({
      type: 'delete-char',
      count: 1,
      backward: false,
    })
  })

  it('swallows Tab and Insert, which Monaco would turn into a buffer edit', () => {
    for (const key of ['Tab', 'Insert']) {
      const result = press(INITIAL_VIM_STATE, key)
      expect(result.handled).toBe(true)
      expect(result.command).toBeNull()
    }
  })

  it('passes non-text keys through to the workbench and Monaco', () => {
    for (const key of [
      'F2',
      'F12',
      'Shift',
      'Control',
      'Alt',
      'Meta',
      'Process',
      'Dead',
      'Unidentified',
      'MediaPlayPause',
    ]) {
      const result = press(INITIAL_VIM_STATE, key)
      expect(result.handled).toBe(false)
      expect(result.command).toBeNull()
      expect(result.state).toEqual(INITIAL_VIM_STATE)
    }
  })

  it('aborts a pending operator when a non-text key passes through', () => {
    const armed = press(INITIAL_VIM_STATE, 'd').state
    const result = press(armed, 'F2')
    expect(result.handled).toBe(false)
    expect(result.state.pendingOperator).toBeNull()
  })

  it('passes everything except Escape through in insert mode', () => {
    const insert = { ...INITIAL_VIM_STATE, mode: 'insert' as const }
    const typed = press(insert, 'j')
    expect(typed.handled).toBe(false)
    expect(typed.command).toBeNull()
    const escaped = press(insert, 'Escape')
    expect(escaped.state.mode).toBe('normal')
    expect(escaped.handled).toBe(true)
    expect(escaped.command).toBeNull()
  })

  it('maps Normal-mode Escape to :nohlsearch', () => {
    const result = press(INITIAL_VIM_STATE, 'Escape')
    expect(result.handled).toBe(true)
    expect(result.command).toEqual({ type: 'search-highlight-clear' })
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

  it('opens forward and backward search, carrying the count', () => {
    expect(press(INITIAL_VIM_STATE, '/').command).toEqual({
      type: 'search-open',
      direction: 'forward',
      count: 1,
    })
    expect(press(INITIAL_VIM_STATE, '?').command).toEqual({
      type: 'search-open',
      direction: 'backward',
      count: 1,
    })
    expect(press(press(INITIAL_VIM_STATE, '3').state, '/').command).toEqual({
      type: 'search-open',
      direction: 'forward',
      count: 3,
    })
    expect(press(INITIAL_VIM_STATE, '/').handled).toBe(true)
  })

  it('repeats search with n / N and honors counts', () => {
    expect(press(INITIAL_VIM_STATE, 'n').command).toEqual({
      type: 'search-repeat',
      reverse: false,
      count: 1,
    })
    expect(press(INITIAL_VIM_STATE, 'N').command).toEqual({
      type: 'search-repeat',
      reverse: true,
      count: 1,
    })
    const counted = press(press(INITIAL_VIM_STATE, '3').state, 'n')
    expect(counted.command).toEqual({ type: 'search-repeat', reverse: false, count: 3 })
  })

  it('cancels a pending operator instead of combining it with search', () => {
    const armed = press(INITIAL_VIM_STATE, 'd').state
    for (const searchKey of ['/', '?', 'n', 'N']) {
      const result = press(armed, searchKey)
      expect(result.handled).toBe(true)
      expect(result.command).toBeNull()
      expect(result.state.pendingOperator).toBeNull()
    }
  })

  it('maps g-prefixed navigation commands', () => {
    const mappings = [
      ['d', 'editor.action.revealDefinition'],
      ['D', 'editor.action.revealDeclaration'],
      ['y', 'editor.action.goToTypeDefinition'],
      ['i', 'editor.action.goToImplementation'],
      ['r', 'editor.action.goToReferences'],
      ['R', 'editor.action.referenceSearch.trigger'],
      ['h', 'editor.action.showHover'],
    ] as const
    for (const [key, commandId] of mappings) {
      const g = press(INITIAL_VIM_STATE, 'g')
      expect(g.state.pendingG).toBe(true)
      const result = press(g.state, key)
      expect(result.command).toEqual({ type: 'editor-command', commandId })
      expect(result.state.pendingG).toBe(false)
    }
  })

  it('maps bracket-prefixed diagnostics and change navigation', () => {
    expect(press(press(INITIAL_VIM_STATE, ']').state, 'd').command).toEqual({
      type: 'editor-command',
      commandId: 'editor.action.marker.nextInFiles',
    })
    expect(press(press(INITIAL_VIM_STATE, '[').state, 'd').command).toEqual({
      type: 'editor-command',
      commandId: 'editor.action.marker.prevInFiles',
    })
    expect(press(press(INITIAL_VIM_STATE, ']').state, 'c').command).toEqual({
      type: 'platform-command',
      commandId: 'workbench.action.editor.nextChange',
      count: 1,
    })
    expect(press(press(INITIAL_VIM_STATE, '[').state, 'c').command).toEqual({
      type: 'platform-command',
      commandId: 'workbench.action.editor.previousChange',
      count: 1,
    })
  })

  it('indents and outdents with >> and << carrying counts', () => {
    expect(press(press(INITIAL_VIM_STATE, '>').state, '>').command).toEqual({
      type: 'indent',
      direction: 'in',
      count: 1,
    })
    const counted = press(press(press(INITIAL_VIM_STATE, '3').state, '>').state, '>')
    expect(counted.command).toEqual({ type: 'indent', direction: 'in', count: 3 })
    expect(press(press(INITIAL_VIM_STATE, '<').state, '<').command).toEqual({
      type: 'indent',
      direction: 'out',
      count: 1,
    })
  })

  it('maps hover, bracket matching and word search', () => {
    expect(press(INITIAL_VIM_STATE, 'K').command).toEqual({
      type: 'editor-command',
      commandId: 'editor.action.showHover',
    })
    expect(press(INITIAL_VIM_STATE, '%').command).toEqual({
      type: 'editor-command',
      commandId: 'editor.action.jumpToBracket',
    })
    expect(press(INITIAL_VIM_STATE, '*').command).toEqual({
      type: 'search-word',
      direction: 'forward',
      count: 1,
    })
    expect(press(INITIAL_VIM_STATE, '#').command).toEqual({
      type: 'search-word',
      direction: 'backward',
      count: 1,
    })
    expect(press(press(INITIAL_VIM_STATE, '2').state, '*').command).toEqual({
      type: 'search-word',
      direction: 'forward',
      count: 2,
    })
  })

  it('lets function keys through a dangling g / bracket / indent prefix', () => {
    for (const prefix of ['g', '[', ']', '>', '<']) {
      const armed = press(INITIAL_VIM_STATE, prefix).state
      const result = press(armed, 'F5')
      expect(result.handled).toBe(false)
      expect(result.command).toBeNull()
    }
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
