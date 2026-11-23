/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  idle,
  isAwaitingCharArg,
  isVimViewportStroke,
  PREFIX_TABLES,
  reduceVimKey,
} from '../vimKeymap.js'
import { INITIAL_VIM_STATE, type VimKeyInput, type VimState } from '../vimTypes.js'

function press(state: VimState, key: string, modifiers: Partial<Omit<VimKeyInput, 'key'>> = {}) {
  return reduceVimKey(state, {
    key,
    ctrl: false,
    alt: false,
    meta: false,
    shift: false,
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
    expect(firstG.state.pending).toEqual({ kind: 'g' })
    expect(press(firstG.state, 'g').command).toEqual({ type: 'motion', motion: 'gg', count: 0 })
    expect(press(INITIAL_VIM_STATE, 'G').command).toEqual({ type: 'motion', motion: 'G', count: 0 })
  })

  it('clears a dangling g when another key arrives', () => {
    const firstG = press(INITIAL_VIM_STATE, 'g')
    const result = press(firstG.state, 'x')
    expect(result.state.pending).toBeNull()
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
    expect(escaped.command).toEqual({ type: 'exit-insert' })
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
      expect(g.state.pending).toEqual({ kind: 'g' })
      const result = press(g.state, key)
      expect(result.command).toEqual({ type: 'editor-command', commandId })
      expect(result.state.pending).toBeNull()
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
      type: 'linewise',
      operator: '>',
      count: 1,
    })
    const counted = press(press(press(INITIAL_VIM_STATE, '3').state, '>').state, '>')
    expect(counted.command).toEqual({ type: 'linewise', operator: '>', count: 3 })
    expect(press(press(INITIAL_VIM_STATE, '<').state, '<').command).toEqual({
      type: 'linewise',
      operator: '<',
      count: 1,
    })
  })

  it('maps hover, bracket matching and word search', () => {
    expect(press(INITIAL_VIM_STATE, 'K').command).toEqual({
      type: 'editor-command',
      commandId: 'editor.action.showHover',
    })
    expect(press(INITIAL_VIM_STATE, '%').command).toEqual({ type: 'motion', motion: '%', count: 0 })
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

  it('maps Ctrl+e/y to viewport scrolling with counts', () => {
    expect(press(INITIAL_VIM_STATE, 'e', { ctrl: true }).command).toEqual({
      type: 'scroll-viewport',
      direction: 'down',
      count: 1,
    })
    expect(press(INITIAL_VIM_STATE, 'y', { ctrl: true }).command).toEqual({
      type: 'scroll-viewport',
      direction: 'up',
      count: 1,
    })
    const counted = press(INITIAL_VIM_STATE, '3').state
    expect(press(counted, 'e', { ctrl: true }).command).toEqual({
      type: 'scroll-viewport',
      direction: 'down',
      count: 3,
    })
  })

  it('resolves zz / zt / zb, using a count as the target line', () => {
    const z = press(INITIAL_VIM_STATE, 'z')
    expect(z.state.pending).toEqual({ kind: 'z' })
    expect(z.command).toBeNull()
    expect(press(z.state, 'z').command).toEqual({ type: 'reveal-line', at: 'center', line: null })
    expect(press(press(INITIAL_VIM_STATE, 'z').state, 't').command).toEqual({
      type: 'reveal-line',
      at: 'top',
      line: null,
    })
    expect(press(press(INITIAL_VIM_STATE, 'z').state, 'b').command).toEqual({
      type: 'reveal-line',
      at: 'bottom',
      line: null,
    })
    const counted = press(press(INITIAL_VIM_STATE, '4').state, 'z').state
    expect(press(counted, 't').command).toEqual({ type: 'reveal-line', at: 'top', line: 4 })
  })

  it('maps z fold commands to Monaco editor actions', () => {
    const z = press(INITIAL_VIM_STATE, 'z').state
    const expected: ReadonlyArray<readonly [string, string]> = [
      ['o', 'editor.unfold'],
      ['O', 'editor.unfoldRecursively'],
      ['c', 'editor.fold'],
      ['C', 'editor.foldRecursively'],
      ['a', 'editor.toggleFold'],
      ['A', 'editor.toggleFoldRecursively'],
      ['M', 'editor.foldAll'],
      ['R', 'editor.unfoldAll'],
      ['j', 'editor.gotoNextFold'],
      ['k', 'editor.gotoPreviousFold'],
    ]
    for (const [key, commandId] of expected) {
      expect(press(z, key).command).toEqual({ type: 'editor-command', commandId })
    }
  })

  it('maps [z / ]z to fold start/end jumps', () => {
    expect(press(press(INITIAL_VIM_STATE, '[').state, 'z').command).toEqual({
      type: 'fold-goto',
      edge: 'start',
    })
    expect(press(press(INITIAL_VIM_STATE, ']').state, 'z').command).toEqual({
      type: 'fold-goto',
      edge: 'end',
    })
  })

  it('clears a dangling z and lets function keys through', () => {
    const swallowed = press(press(INITIAL_VIM_STATE, 'z').state, 'x')
    expect(swallowed.state.pending).toBeNull()
    expect(swallowed.command).toBeNull()
    expect(swallowed.handled).toBe(true)

    const passed = press(press(INITIAL_VIM_STATE, 'z').state, 'F5')
    expect(passed.state.pending).toBeNull()
    expect(passed.handled).toBe(false)
  })

  it('maps H / M / L to visible-line jumps with counts', () => {
    expect(press(INITIAL_VIM_STATE, 'H').command).toEqual({
      type: 'goto-viewport-line',
      at: 'top',
      count: 1,
    })
    expect(press(INITIAL_VIM_STATE, 'M').command).toEqual({
      type: 'goto-viewport-line',
      at: 'middle',
      count: 1,
    })
    expect(press(INITIAL_VIM_STATE, 'L').command).toEqual({
      type: 'goto-viewport-line',
      at: 'bottom',
      count: 1,
    })
    expect(press(press(INITIAL_VIM_STATE, '2').state, 'H').command).toEqual({
      type: 'goto-viewport-line',
      at: 'top',
      count: 2,
    })
  })

  it('cancels a pending operator on z / H / M / L', () => {
    for (const key of ['z', 'H', 'M', 'L']) {
      const armed = press(INITIAL_VIM_STATE, 'd').state
      const result = press(armed, key)
      expect(result.state.pendingOperator).toBeNull()
      expect(result.command).toBeNull()
      expect(result.handled).toBe(true)
    }
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

describe('isVimViewportStroke', () => {
  it('accepts only plain Ctrl + f/b/d/u/e/y', () => {
    expect(isVimViewportStroke({ key: 'f', ctrlKey: true, altKey: false, metaKey: false })).toBe(
      true,
    )
    expect(isVimViewportStroke({ key: 'e', ctrlKey: true, altKey: false, metaKey: false })).toBe(
      true,
    )
    expect(isVimViewportStroke({ key: 'y', ctrlKey: true, altKey: false, metaKey: false })).toBe(
      true,
    )
    expect(
      isVimViewportStroke({
        key: 'F',
        ctrlKey: true,
        altKey: false,
        metaKey: false,
        shiftKey: true,
      }),
    ).toBe(false)
    expect(isVimViewportStroke({ key: 'f', ctrlKey: true, altKey: true, metaKey: false })).toBe(
      false,
    )
    expect(isVimViewportStroke({ key: 'f', ctrlKey: true, altKey: false, metaKey: true })).toBe(
      false,
    )
    expect(isVimViewportStroke({ key: 'j', ctrlKey: true, altKey: false, metaKey: false })).toBe(
      false,
    )
    expect(isVimViewportStroke({ key: 'f', ctrlKey: false, altKey: false, metaKey: false })).toBe(
      false,
    )
  })
})

describe('reduceVimKey: counts, Escape and prefixes', () => {
  function run(...keys: string[]) {
    let state: VimState = INITIAL_VIM_STATE
    let last = press(state, keys[0]!)
    state = last.state
    for (const k of keys.slice(1)) {
      last = press(state, k)
      state = last.state
    }
    return last
  }

  it('multiplies the count before an operator with the count after it', () => {
    expect(run('2', 'd', '3', 'w').command).toEqual({
      type: 'operator',
      operator: 'd',
      motion: 'w',
      count: 6,
    })
    expect(run('2', 'd', 'd').command).toEqual({ type: 'linewise', operator: 'd', count: 2 })
    expect(run('2', 'd', '3', 'd').command).toEqual({ type: 'linewise', operator: 'd', count: 6 })
    // 0 after the operator's count is the line-start motion, not a digit of it.
    expect(run('3', 'd', '0').command).toEqual({
      type: 'operator',
      operator: 'd',
      motion: '0',
      count: 3,
    })
  })

  it('treats > and < as operators that take motions', () => {
    expect(run('>', 'j').command).toEqual({
      type: 'operator',
      operator: '>',
      motion: 'j',
      count: 0,
    })
    expect(run('<', 'G').command).toEqual({
      type: 'operator',
      operator: '<',
      motion: 'G',
      count: 0,
    })
    expect(run('3', '>', '>').command).toEqual({ type: 'linewise', operator: '>', count: 3 })
  })

  it('treats Ctrl+[ as Escape in both modes', () => {
    const insert = { ...INITIAL_VIM_STATE, mode: 'insert' as const }
    const exited = press(insert, '[', { ctrl: true })
    expect(exited.handled).toBe(true)
    expect(exited.state.mode).toBe('normal')
    expect(exited.command).toEqual({ type: 'exit-insert' })
    expect(press(INITIAL_VIM_STATE, '[', { ctrl: true }).command).toEqual({
      type: 'search-highlight-clear',
    })
    // A plain [ still opens the bracket prefix.
    expect(press(INITIAL_VIM_STATE, '[').state.pending).toEqual({ kind: '[' })
  })

  it('spends an Escape that cancels something and drops the whole pending state', () => {
    for (const keys of [['2'], ['d'], ['g'], ['2', 'd']]) {
      const armed = run(...keys)
      const escaped = press(armed.state, 'Escape')
      expect(escaped.command, keys.join('')).toBeNull()
      expect(escaped.state, keys.join('')).toEqual(INITIAL_VIM_STATE)
    }
  })

  it('exports idle() that clears every in-flight field but keeps the mode', () => {
    const dirty: VimState = {
      ...INITIAL_VIM_STATE,
      count: 4,
      operatorCount: 2,
      pendingOperator: 'd',
      pending: { kind: 'g' },
      register: 'a',
    }
    expect(idle(dirty)).toEqual(INITIAL_VIM_STATE)
    expect(idle({ ...dirty, mode: 'visual' }).mode).toBe('visual')
  })

  it('resolves every prefix through PREFIX_TABLES and rejects z after an operator', () => {
    expect(Object.keys(PREFIX_TABLES).sort()).toEqual(['[', ']', 'g', 'z'])
    expect(run('d', 'g', 'g').command).toEqual({
      type: 'operator',
      operator: 'd',
      motion: 'gg',
      count: 0,
    })
    const dz = run('d', 'z')
    expect(dz.state).toEqual(INITIAL_VIM_STATE)
    expect(dz.command).toBeNull()
  })

  it('uses one rule for unclaimed keys after a prefix or an operator', () => {
    for (const prefix of [['g'], ['z'], ['d']]) {
      const printable = run(...prefix, 'Q')
      expect(printable.handled, prefix.join('')).toBe(true)
      expect(printable.command, prefix.join('')).toBeNull()
      const fkey = run(...prefix, 'F5')
      expect(fkey.handled, prefix.join('')).toBe(false)
      expect(fkey.state, prefix.join('')).toEqual(INITIAL_VIM_STATE)
    }
  })
})

describe('reduceVimKey: pending argument keys', () => {
  function run(...keys: string[]) {
    let state: VimState = INITIAL_VIM_STATE
    let last = press(state, keys[0]!)
    state = last.state
    for (const k of keys.slice(1)) {
      last = press(state, k)
      state = last.state
    }
    return last
  }

  const EDITING_KEYS = ['Backspace', 'Delete', 'Enter', 'Tab', 'ArrowLeft', 'ArrowDown', 'Home']

  it('swallows editing keys that arrive while f / t / F / T wait for a character', () => {
    for (const lead of ['f', 'F', 't', 'T']) {
      for (const key of ['Backspace', 'Delete', 'ArrowLeft', 'ArrowDown', 'Home', 'Enter']) {
        const result = run(lead, key)
        expect(result.handled, `${lead}<${key}>`).toBe(true)
        expect(result.command, `${lead}<${key}>`).toBeNull()
        expect(result.state, `${lead}<${key}>`).toEqual(INITIAL_VIM_STATE)
      }
    }
  })

  it('treats <Tab> as the tab character for f / r', () => {
    expect(run('f', 'Tab').command).toEqual({ type: 'motion', motion: 'f', count: 0, char: '\t' })
    expect(run('r', 'Tab').command).toEqual({ type: 'replace-char', char: '\t', count: 1 })
  })

  it('r<CR> still replaces with a line break, but other editing keys cancel the replace', () => {
    expect(run('r', 'Enter').command).toEqual({ type: 'replace-char', char: '\n', count: 1 })
    for (const key of ['Backspace', 'Delete', 'ArrowLeft', 'Home']) {
      const result = run('r', key)
      expect(result.handled, key).toBe(true)
      expect(result.command, key).toBeNull()
      expect(result.state, key).toEqual(INITIAL_VIM_STATE)
    }
  })

  it('cancels a pending register name, and an operator pending behind it', () => {
    for (const key of EDITING_KEYS) {
      const result = run('"', key)
      expect(result.handled, key).toBe(true)
      expect(result.command, key).toBeNull()
      expect(result.state, key).toEqual(INITIAL_VIM_STATE)
    }
  })

  it('cancels operator + i / a waiting for an object key, dropping the operator too', () => {
    for (const around of ['i', 'a']) {
      for (const key of EDITING_KEYS) {
        const result = run('d', around, key)
        expect(result.handled, `d${around}<${key}>`).toBe(true)
        expect(result.command, `d${around}<${key}>`).toBeNull()
        expect(result.state, `d${around}<${key}>`).toEqual(INITIAL_VIM_STATE)
      }
    }
  })

  it('cancels Visual r<BS> without leaving Visual', () => {
    const visual = press(INITIAL_VIM_STATE, 'v').state
    const result = press(press(visual, 'r').state, 'Backspace')
    expect(result.handled).toBe(true)
    expect(result.command).toBeNull()
    expect(result.state.mode).toBe('visual')
    expect(result.state.pending).toBeNull()
  })

  it('cancels a dangling g / z / [ prefix instead of running the editing key', () => {
    for (const prefix of ['g', 'z', '[', ']']) {
      for (const key of ['Backspace', 'Delete', 'Enter', 'ArrowRight']) {
        const result = run(prefix, key)
        expect(result.handled, `${prefix}<${key}>`).toBe(true)
        expect(result.command, `${prefix}<${key}>`).toBeNull()
        expect(result.state, `${prefix}<${key}>`).toEqual(INITIAL_VIM_STATE)
      }
    }
  })

  it('does not turn <Del> into x while an operator waits', () => {
    const result = run('d', 'Delete')
    expect(result.command).toBeNull()
    expect(result.handled).toBe(true)
    expect(result.state).toEqual(INITIAL_VIM_STATE)
  })

  it('Esc cancels every argument-taking pending state', () => {
    for (const keys of [['f'], ['r'], ['"'], ['d', 'i'], ['d', 'a'], ['2', 'f']]) {
      const armed = run(...keys)
      const result = press(armed.state, 'Escape')
      expect(result.handled, keys.join('')).toBe(true)
      expect(result.command, keys.join('')).toBeNull()
      expect(result.state, keys.join('')).toEqual(INITIAL_VIM_STATE)
    }
  })

  it('still lets function keys through an argument wait', () => {
    for (const lead of ['f', 'r', '"']) {
      const result = run(lead, 'F5')
      expect(result.handled).toBe(false)
      expect(result.state).toEqual(INITIAL_VIM_STATE)
    }
  })
})

describe('isAwaitingCharArg', () => {
  const after = (...keys: string[]) =>
    keys.reduce<VimState>((state, key) => press(state, key).state, INITIAL_VIM_STATE)

  it('is true while f / t / r / " / i / a wait for their argument', () => {
    for (const keys of [['f'], ['F'], ['t'], ['T'], ['r'], ['"'], ['d', 'i'], ['y', 'a']]) {
      expect(isAwaitingCharArg(after(...keys)), keys.join('')).toBe(true)
    }
    const visual = press(INITIAL_VIM_STATE, 'v').state
    expect(isAwaitingCharArg(press(visual, 'r').state)).toBe(true)
    expect(isAwaitingCharArg(press(visual, 'i').state)).toBe(true)
  })

  it('is false when idle, with an operator, a count or a prefix pending', () => {
    for (const keys of [[], ['d'], ['3'], ['g'], ['z'], ['['], ['"', 'a'], ['2', 'd', '3']]) {
      expect(isAwaitingCharArg(after(...keys)), keys.join('')).toBe(false)
    }
  })

  it('is false again after the argument arrives', () => {
    expect(isAwaitingCharArg(after('r', 'x'))).toBe(false)
    expect(isAwaitingCharArg(after('f', ' '))).toBe(false)
  })

  it('takes Space as the argument of r / f, not as anything else', () => {
    expect(press(after('r'), ' ').command).toEqual({ type: 'replace-char', char: ' ', count: 1 })
    expect(press(after('f'), ' ').command).toEqual({
      type: 'motion',
      motion: 'f',
      count: 0,
      char: ' ',
    })
  })
})

describe('reduceVimKey: digits inside prefixes and counts', () => {
  function run(...keys: string[]) {
    let state: VimState = INITIAL_VIM_STATE
    let last = press(state, keys[0]!)
    state = last.state
    for (const k of keys.slice(1)) {
      last = press(state, k)
      state = last.state
    }
    return last
  }

  it('g0 / g3 are not counts or motions: the prefix is cancelled and the key swallowed', () => {
    for (const key of ['0', '3']) {
      const result = run('g', key)
      expect(result.handled, key).toBe(true)
      expect(result.command, key).toBeNull()
      expect(result.state, key).toEqual(INITIAL_VIM_STATE)
      expect(result.unsupported, key).toBe(key)
    }
    // The next key starts fresh instead of inheriting a count.
    expect(run('g', '3', 'j').command).toEqual({ type: 'motion', motion: 'j', count: 0 })
  })

  it('a count typed before the prefix survives into the prefixed command', () => {
    expect(run('3', 'g', 'g').command).toEqual({ type: 'motion', motion: 'gg', count: 3 })
    expect(run('2', 'z', 't').command).toEqual({ type: 'reveal-line', at: 'top', line: 2 })
  })

  it('2d3w multiplies the counts, and 2d3d / d2d keep both', () => {
    expect(run('2', 'd', '3', 'w').command).toEqual({
      type: 'operator',
      operator: 'd',
      motion: 'w',
      count: 6,
    })
    expect(run('2', 'd', '3', 'd').command).toEqual({
      type: 'linewise',
      operator: 'd',
      count: 6,
    })
    expect(run('d', '2', 'd').command).toEqual({ type: 'linewise', operator: 'd', count: 2 })
  })

  it('a count straddling a register and an operator is still multiplied', () => {
    const result = run('"', 'a', '2', 'd', '3', 'w')
    expect(result.command).toEqual({ type: 'operator', operator: 'd', motion: 'w', count: 6 })
    expect(result.register).toBe('a')
  })

  it('10 and 0 after an operator count behave as digits, not as the line start', () => {
    expect(run('d', '1', '0', 'j').command).toEqual({
      type: 'operator',
      operator: 'd',
      motion: 'j',
      count: 10,
    })
  })
})

describe('reduceVimKey: registers', () => {
  const run = (...keys: string[]) =>
    keys.reduce((acc, key) => press(acc.state, key), { state: INITIAL_VIM_STATE } as ReturnType<
      typeof press
    >)

  it('accepts digits and - as register names', () => {
    for (const name of ['1', '9', '-', '0', 'a', 'A', '_', '+']) {
      expect(run('"', name, 'y', 'y').register, name).toBe(name)
    }
  })

  it('treats "" as the unnamed register: the same as no register', () => {
    const result = run('"', '"', 'y', 'y')
    expect(result.register).toBeNull()
    expect(result.command).toEqual({ type: 'linewise', operator: 'y', count: 1 })
  })
})

describe('reduceVimKey: g v', () => {
  it('reselects in Normal and in Visual, but not after an operator', () => {
    expect(press(press(INITIAL_VIM_STATE, 'g').state, 'v').command).toEqual({
      type: 'visual-reselect',
    })
    const visual = press(INITIAL_VIM_STATE, 'v').state
    expect(press(press(visual, 'g').state, 'v').command).toEqual({ type: 'visual-reselect' })
    const afterOperator = press(press(press(INITIAL_VIM_STATE, 'd').state, 'g').state, 'v')
    expect(afterOperator.command).toBeNull()
    expect(afterOperator.state).toEqual(INITIAL_VIM_STATE)
  })
})

describe('reduceVimKey: display-line motions', () => {
  function run(...keys: string[]) {
    let state: VimState = INITIAL_VIM_STATE
    let last = press(state, keys[0]!)
    state = last.state
    for (const key of keys.slice(1)) {
      last = press(state, key)
      state = last.state
    }
    return last
  }

  it('reaches gj / gk through the g prefix', () => {
    expect(run('g', 'j').command).toEqual({ type: 'motion', motion: 'gj', count: 0 })
    expect(run('g', 'k').command).toEqual({ type: 'motion', motion: 'gk', count: 0 })
    expect(run('3', 'g', 'j').command).toEqual({ type: 'motion', motion: 'gj', count: 3 })
  })

  it('stays usable as an operator motion', () => {
    expect(run('d', 'g', 'j').command).toEqual({
      type: 'operator',
      operator: 'd',
      motion: 'gj',
      count: 0,
    })
    expect(run('y', '2', 'g', 'k').command).toEqual({
      type: 'operator',
      operator: 'y',
      motion: 'gk',
      count: 2,
    })
  })

  it('works in Visual mode', () => {
    expect(run('v', 'g', 'j').command).toEqual({ type: 'motion', motion: 'gj', count: 0 })
  })
})
