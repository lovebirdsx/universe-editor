/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it } from 'vitest'
import { getVimRegister, resetVimRegisterForTests } from '../vimRegisters.js'
import { resetVimSessionForTests } from '../vimSession.js'
import { createVimHarness } from './fakeVimEditor.js'

beforeEach(() => {
  resetVimRegisterForTests()
  resetVimSessionForTests()
})

describe('Visual mode (characterwise)', () => {
  it('extends the selection with motions and deletes it inclusively', () => {
    const h = createVimHarness(['hello world'])
    h.keys('vee')
    expect(h.fake.selection()).toMatchObject({ startColumn: 1, endColumn: 12 })
    h.keys('d')
    expect(h.fake.lines()).toEqual([''])
    expect(getVimRegister()).toEqual({ text: 'hello world', linewise: false })
  })

  it('selects backwards inclusively and swaps ends with o', () => {
    const h = createVimHarness(['abcdef'])
    h.fake.setCursor(1, 4)
    h.keys('vhh')
    expect(h.fake.selection()).toMatchObject({ startColumn: 2, endColumn: 5 })
    h.keys('o')
    h.keys('l')
    expect(h.fake.selection()).toMatchObject({ startColumn: 2, endColumn: 6 })
    h.keys('y')
    expect(getVimRegister()).toEqual({ text: 'bcde', linewise: false })
    expect(h.fake.cursor()).toEqual({ line: 1, column: 2 })
  })

  it('applies y, c, ~, u, U, r, > and J', () => {
    const y = createVimHarness(['abc def'])
    y.keys('veY'.replace('Y', 'y'))
    expect(getVimRegister()?.text).toBe('abc')
    const c = createVimHarness(['abc def'])
    c.keys('vec')
    expect(c.vim.modes.get('editor:test')).toBe('insert')
    c.fake.typeText('X')
    c.keys('<Esc>')
    expect(c.fake.lines()).toEqual(['X def'])
    const t = createVimHarness(['abc def'])
    t.keys('ve~')
    expect(t.fake.lines()).toEqual(['ABC def'])
    t.keys('wveU')
    expect(t.fake.lines()).toEqual(['ABC DEF'])
    t.keys('0veu')
    expect(t.fake.lines()).toEqual(['abc DEF'])
    const r = createVimHarness(['abc'])
    r.keys('vlrx')
    expect(r.fake.lines()).toEqual(['xxc'])
    const j = createVimHarness(['a', 'b', 'c'])
    j.keys('vjJ')
    expect(j.fake.lines()).toEqual(['a b', 'c'])
    const shift = createVimHarness(['a', 'b'])
    shift.keys('vj>')
    expect(shift.fake.lines()).toEqual(['  a', '  b'])
  })

  it('p replaces the selection and swaps it into the register', () => {
    const h = createVimHarness(['one two'])
    h.keys('yiw')
    h.keys('w')
    h.keys('viwp')
    expect(h.fake.lines()).toEqual(['one one'])
    expect(getVimRegister()).toEqual({ text: 'two', linewise: false })
    h.keys('0viwP')
    expect(getVimRegister()).toEqual({ text: 'two', linewise: false })
  })

  it('extends with text objects and switches kind with V / v', () => {
    const h = createVimHarness(['f(a, b) x'])
    h.fake.setCursor(1, 4)
    h.keys('vi(')
    expect(h.fake.selection()).toMatchObject({ startColumn: 3, endColumn: 7 })
    h.keys('a(')
    expect(h.fake.selection()).toMatchObject({ startColumn: 2, endColumn: 8 })
    h.keys('V')
    expect(h.fake.selection()).toMatchObject({ startColumn: 1, endColumn: 10 })
    h.keys('v')
    expect(h.callbacks.onSubModeChange).toHaveBeenLastCalledWith('visual')
  })

  it('leaves with Esc or Ctrl+[ and keeps the cursor; gv reselects', () => {
    const h = createVimHarness(['abcdef'])
    h.keys('vll<Esc>')
    expect(h.fake.cursor()).toEqual({ line: 1, column: 3 })
    expect(h.fake.selection()).toMatchObject({ startColumn: 3, endColumn: 3 })
    h.keys('gv')
    expect(h.fake.selection()).toMatchObject({ startColumn: 1, endColumn: 4 })
    h.keys('<C-[>')
    expect(h.callbacks.onSubModeChange).toHaveBeenLastCalledWith('normal')
  })

  it('selecting an empty line then d removes its break', () => {
    const h = createVimHarness(['a', '', 'b'])
    h.keys('jvd')
    expect(h.fake.lines()).toEqual(['a', 'b'])
  })
})

describe('Visual mode (linewise and blockwise)', () => {
  it('V selects whole lines for d, y and >', () => {
    const h = createVimHarness(['a', 'b', 'c'])
    h.keys('Vjd')
    expect(h.fake.lines()).toEqual(['c'])
    expect(getVimRegister()).toEqual({ text: 'a\nb\n', linewise: true })
    const y = createVimHarness(['a', 'b'])
    y.keys('Vjy')
    expect(getVimRegister()).toEqual({ text: 'a\nb\n', linewise: true })
    expect(y.fake.cursor()).toEqual({ line: 1, column: 1 })
  })

  it('X / Y / D act on whole lines from characterwise Visual', () => {
    const h = createVimHarness(['abc', 'def'])
    h.keys('lvX')
    expect(h.fake.lines()).toEqual(['def'])
  })

  it('Ctrl+V renders one selection per row and deletes the block', () => {
    const h = createVimHarness(['abcd', 'efgh', 'ijkl'])
    h.keys('l<C-v>jl')
    expect(h.fake.selections()).toHaveLength(2)
    expect(h.callbacks.onSubModeChange).toHaveBeenLastCalledWith('visual-block')
    h.keys('d')
    expect(h.fake.lines()).toEqual(['ad', 'eh', 'ijkl'])
    expect(getVimRegister()).toEqual({ text: 'bc\nfg', linewise: false, blockwise: true })
  })

  it('block I and A put a cursor on every row', () => {
    const h = createVimHarness(['abcd', 'efgh'])
    h.keys('l<C-v>jlI')
    expect(h.fake.cursors()).toEqual([
      { line: 1, column: 2 },
      { line: 2, column: 2 },
    ])
    h.fake.typeText('-')
    h.keys('<Esc>')
    expect(h.fake.lines()).toEqual(['a-bcd', 'e-fgh'])
    expect(h.fake.cursors()).toHaveLength(1)
    const a = createVimHarness(['abcd', 'efgh'])
    a.keys('<C-v>jlA')
    a.fake.typeText('+')
    a.keys('<Esc>')
    expect(a.fake.lines()).toEqual(['ab+cd', 'ef+gh'])
  })

  it('block c replaces the column on every row and $ extends to line ends', () => {
    const h = createVimHarness(['abc', 'de', 'fgh'])
    h.keys('l<C-v>jjc')
    h.fake.typeText('X')
    h.keys('<Esc>')
    expect(h.fake.lines()).toEqual(['aXc', 'dX', 'fXh'])
    const d = createVimHarness(['abc', 'de'])
    d.keys('l<C-v>jD')
    expect(d.fake.lines()).toEqual(['a', 'd'])
  })

  it('o swaps the corner and O the column in block mode', () => {
    const h = createVimHarness(['abcd', 'efgh'])
    h.keys('<C-v>jl')
    h.keys('O')
    h.keys('d')
    expect(h.fake.lines()).toEqual(['cd', 'gh'])
  })

  it('toggling the same kind leaves Visual', () => {
    const h = createVimHarness(['abc'])
    h.keys('vv')
    expect(h.callbacks.onSubModeChange).toHaveBeenLastCalledWith('normal')
    h.keys('<C-v><C-v>')
    expect(h.callbacks.onSubModeChange).toHaveBeenLastCalledWith('normal')
  })
})

describe('dot repeat of Visual operators', () => {
  it('replays over an equally sized selection', () => {
    const h = createVimHarness(['abcdef ghijkl'])
    h.keys('vld')
    expect(h.fake.lines()).toEqual(['cdef ghijkl'])
    h.keys('.')
    expect(h.fake.lines()).toEqual(['ef ghijkl'])
  })
})

describe('cursor style', () => {
  it('uses a block cursor in Normal and Visual and restores the user style in Insert', () => {
    const h = createVimHarness(['abc'], { config: { 'editor.cursorStyle': 'underline' } })
    expect(h.fake.editor.updateOptions).toHaveBeenLastCalledWith({ cursorStyle: 'block' })
    h.keys('i')
    expect(h.fake.editor.updateOptions).toHaveBeenLastCalledWith({ cursorStyle: 'underline' })
    h.keys('<Esc>')
    expect(h.fake.editor.updateOptions).toHaveBeenLastCalledWith({ cursorStyle: 'block' })
    h.keys('v')
    expect(h.fake.editor.updateOptions).toHaveBeenLastCalledWith({ cursorStyle: 'block' })
  })

  it('falls back to line when the user set nothing, and reapplies after config changes', async () => {
    const h = createVimHarness(['abc'])
    h.keys('i')
    expect(h.fake.editor.updateOptions).toHaveBeenLastCalledWith({ cursorStyle: 'line' })
    h.keys('<Esc>')
    const calls = vi_calls(h.fake.editor.updateOptions)
    h.config.fire('editor.cursorStyle')
    await Promise.resolve()
    expect(vi_calls(h.fake.editor.updateOptions)).toBe(calls + 1)
    expect(h.fake.editor.updateOptions).toHaveBeenLastCalledWith({ cursorStyle: 'block' })
  })

  it('puts the user style back when Vim is switched off', () => {
    const h = createVimHarness(['abc'], { config: { 'editor.cursorStyle': 'line-thin' } })
    h.config.set('vim.enabled', false)
    h.config.fire('vim.enabled')
    expect(h.fake.editor.updateOptions).toHaveBeenLastCalledWith({ cursorStyle: 'line-thin' })
  })
})

function vi_calls(fn: unknown): number {
  return (fn as { mock: { calls: unknown[] } }).mock.calls.length
}

describe('pending, unsupported and sub-mode reporting', () => {
  it('reports the typed prefix as it grows and clears', () => {
    const h = createVimHarness(['abc'])
    h.keys('2')
    expect(h.callbacks.onPendingKeysChange).toHaveBeenLastCalledWith('2')
    h.keys('d')
    expect(h.callbacks.onPendingKeysChange).toHaveBeenLastCalledWith('2d')
    h.keys('3')
    expect(h.callbacks.onPendingKeysChange).toHaveBeenLastCalledWith('2d3')
    h.keys('w')
    expect(h.callbacks.onPendingKeysChange).toHaveBeenLastCalledWith('')
    h.keys('"a')
    expect(h.callbacks.onPendingKeysChange).toHaveBeenLastCalledWith('"a')
    h.keys('<Esc>')
    expect(h.callbacks.onPendingKeysChange).toHaveBeenLastCalledWith('')
    h.keys('g')
    expect(h.callbacks.onPendingKeysChange).toHaveBeenLastCalledWith('g')
  })

  it('reports swallowed unsupported keys but not supported ones', () => {
    const h = createVimHarness(['abc'])
    h.keys('Q')
    expect(h.callbacks.onUnsupportedKey).toHaveBeenCalledWith('Q')
    h.keys('l')
    expect(h.callbacks.onUnsupportedKey).toHaveBeenCalledTimes(1)
    expect(h.keys('<F2>')).toBe(false)
    expect(h.callbacks.onUnsupportedKey).toHaveBeenCalledTimes(1)
  })

  it('reports Normal, Insert and Visual sub-modes', () => {
    const h = createVimHarness(['abc'])
    const modes = () => h.callbacks.onSubModeChange.mock.calls.map(([mode]) => mode)
    h.keys('i<Esc>vV<C-v><Esc>')
    expect(new Set(modes())).toEqual(
      new Set(['normal', 'insert', 'visual', 'visual-line', 'visual-block']),
    )
    expect(modes().at(-1)).toBe('normal')
  })

  it('reports Visual to the mode service as Normal so context keys keep working', () => {
    const h = createVimHarness(['abc'])
    h.keys('v')
    expect(h.vim.modes.get('editor:test')).toBe('normal')
  })
})

describe('vim.surfaces.editor', () => {
  it('handles no keys, switches no IME and resets state when switched off', async () => {
    const h = createVimHarness(['abc def'])
    h.keys('2d')
    expect(h.callbacks.onPendingKeysChange).toHaveBeenLastCalledWith('2d')
    h.config.set('vim.surfaces.editor', false)
    h.config.fire('vim.surfaces.editor')
    expect(h.controller.isEnabled()).toBe(false)
    expect(h.callbacks.onPendingKeysChange).toHaveBeenLastCalledWith('')
    expect(h.keys('x')).toBe(false)
    expect(h.fake.lines()).toEqual(['abc def'])
    await Promise.resolve()
    expect(h.inputMethod.restore).toHaveBeenCalled()
    expect(h.fake.editor.updateOptions).toHaveBeenLastCalledWith({ cursorStyle: 'line' })
  })

  it('drops an active Visual selection and comes back to a clean Normal state', () => {
    const h = createVimHarness(['abcdef'])
    h.keys('vll')
    h.config.set('vim.surfaces.editor', false)
    h.config.fire('vim.surfaces.editor')
    expect(h.fake.selection()).toMatchObject({ startColumn: 3, endColumn: 3 })
    h.config.set('vim.surfaces.editor', true)
    h.config.fire('vim.surfaces.editor')
    expect(h.controller.isEnabled()).toBe(true)
    h.keys('x')
    expect(h.fake.lines()).toEqual(['abdef'])
  })

  it('starts disabled when the config is already false', () => {
    const h = createVimHarness(['abc'], { config: { 'vim.surfaces.editor': false } })
    expect(h.controller.isEnabled()).toBe(false)
    expect(h.keys('x')).toBe(false)
  })
})
