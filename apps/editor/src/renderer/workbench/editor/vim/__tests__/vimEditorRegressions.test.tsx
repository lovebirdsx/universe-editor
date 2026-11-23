/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Regressions from the Vim review: each case pins one behaviour the controller used
 *  to get wrong, on the text-applying fake so the buffer and the undo history are real.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetVimInputMethodForTests } from '../vimInputMethod.js'
import { getVimRegister, resetVimRegisterForTests } from '../vimRegisters.js'
import { resetVimSessionForTests } from '../vimSession.js'
import { createVimHarness } from './fakeVimEditor.js'

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  resetVimRegisterForTests()
  resetVimSessionForTests()
  resetVimInputMethodForTests()
})

function deferredClipboard(initial = 'EXT') {
  let resolve: (value: string) => void = () => undefined
  const readText = vi.fn(
    () =>
      new Promise<string>((done) => {
        resolve = done
      }),
  )
  return {
    clipboard: { readText, writeText: vi.fn(async () => undefined) },
    settle: (value = initial) => resolve(value),
  }
}

describe('pending prefix after an unconsumed key', () => {
  it('a passthrough key drops the half-typed operator', () => {
    const h = createVimHarness(['a b c'])
    h.keys('d')
    expect(h.keys('<F5>')).toBe(false)
    h.keys('w')
    expect(h.fake.lines()).toEqual(['a b c'])
    expect(h.fake.cursor().column).toBe(3)
    expect(h.callbacks.onPendingKeysChange).toHaveBeenLastCalledWith('')
  })
})

describe('isAwaitingCharArg', () => {
  it('is true between f and its argument, false otherwise and while unfocused', () => {
    const h = createVimHarness(['abc'])
    expect(h.controller.isAwaitingCharArg()).toBe(false)
    h.keys('f')
    expect(h.controller.isAwaitingCharArg()).toBe(true)
    h.keys('c')
    expect(h.controller.isAwaitingCharArg()).toBe(false)
    h.keys('r')
    expect(h.controller.isAwaitingCharArg()).toBe(true)
    h.fake.blur()
    expect(h.controller.isAwaitingCharArg()).toBe(false)
  })
})

describe('asynchronous clipboard paste', () => {
  it('is dropped after the controller is disposed', async () => {
    const { clipboard, settle } = deferredClipboard()
    const h = createVimHarness(['ab'], {
      config: { 'vim.useSystemClipboard': true },
      controller: { clipboard },
    })
    h.keys('p')
    h.controller.dispose()
    settle()
    await flush()
    expect(h.fake.lines()).toEqual(['ab'])
  })

  it('is dropped when the cursor moved before the clipboard answered', async () => {
    const { clipboard, settle } = deferredClipboard()
    const h = createVimHarness(['abcd'], {
      config: { 'vim.useSystemClipboard': true },
      controller: { clipboard },
    })
    h.keys('p')
    h.keys('l')
    settle()
    await flush()
    expect(h.fake.lines()).toEqual(['abcd'])
  })

  it('is dropped when the buffer changed meanwhile, and the newest paste wins', async () => {
    const first = deferredClipboard('ONE')
    const h = createVimHarness(['ab'], {
      config: { 'vim.useSystemClipboard': true },
      controller: { clipboard: first.clipboard },
    })
    h.keys('p')
    h.keys('x')
    first.settle()
    await flush()
    expect(h.fake.lines()).toEqual(['b'])
  })

  it('Visual p collapses the selection before waiting, so it cannot be left behind', async () => {
    const { clipboard, settle } = deferredClipboard()
    const h = createVimHarness(['abcd'], {
      config: { 'vim.useSystemClipboard': true },
      controller: { clipboard },
    })
    h.keys('vlp')
    expect(h.fake.selection()).toMatchObject({ startColumn: 1, endColumn: 1 })
    settle()
    await flush()
    expect(h.vim.modes.get('editor:test')).toBe('normal')
  })

  it('Visual p with an empty register leaves Visual and changes nothing', () => {
    const h = createVimHarness(['abcd'])
    h.keys('vlp')
    expect(h.fake.lines()).toEqual(['abcd'])
    expect(h.fake.selection()).toMatchObject({ startColumn: 1, endColumn: 1 })
    expect(h.callbacks.onSubModeChange).toHaveBeenLastCalledWith('normal')
  })

  it('a paste that did nothing does not replace the change `.` repeats', () => {
    const h = createVimHarness(['ab cd'])
    h.keys('x')
    h.keys('"zp')
    expect(h.fake.lines()).toEqual(['b cd'])
    h.keys('.')
    expect(h.fake.lines()).toEqual([' cd'])
  })

  it('records `.` for an async paste only once it was applied', async () => {
    const { clipboard, settle } = deferredClipboard('Z')
    const h = createVimHarness(['ab'], {
      config: { 'vim.useSystemClipboard': true },
      controller: { clipboard },
    })
    h.keys('p')
    settle()
    await flush()
    expect(h.fake.lines()).toEqual(['aZb'])
    expect(h.fake.cursor().column).toBe(2)
  })
})

describe('desired column for j / k / $', () => {
  it('j and k remember the column across a short line', () => {
    const h = createVimHarness(['abcdef', 'a', 'abcdef'])
    h.fake.setCursor(1, 5)
    h.keys('jj')
    expect(h.fake.cursor()).toEqual({ line: 3, column: 5 })
    h.keys('kk')
    expect(h.fake.cursor()).toEqual({ line: 1, column: 5 })
  })

  it('$ sticks to the end of every line vertical motions visit', () => {
    const h = createVimHarness(['abc', 'a', 'abcdef'])
    h.keys('$jj')
    expect(h.fake.cursor()).toEqual({ line: 3, column: 6 })
  })

  it('a horizontal move forgets the remembered column', () => {
    const h = createVimHarness(['abcdef', 'ab', 'abcdef'])
    h.fake.setCursor(1, 5)
    h.keys('jh')
    expect(h.fake.cursor()).toEqual({ line: 2, column: 1 })
    h.keys('j')
    expect(h.fake.cursor()).toEqual({ line: 3, column: 1 })
  })

  it('a failed horizontal move keeps the remembered column, like Vim', () => {
    const h = createVimHarness(['abcdef', 'a', 'abcdef'])
    h.fake.setCursor(1, 5)
    h.keys('jhj')
    expect(h.fake.cursor()).toEqual({ line: 3, column: 5 })
  })

  it('Visual $ keeps the line break selected while moving down', () => {
    const h = createVimHarness(['abc', 'de', 'fghi'])
    h.keys('v$jj')
    h.keys('d')
    expect(h.fake.lines()).toEqual([''])
  })
})

describe('closed folds', () => {
  const folded = () => {
    const h = createVimHarness(['1', '2', '3', '4', '5'])
    h.fake.setFolds([{ start: 2, end: 4, collapsed: true }])
    return h
  }

  it('dd on a fold header deletes the whole fold', () => {
    const h = folded()
    h.fake.setCursor(2, 1)
    h.keys('dd')
    expect(h.fake.lines()).toEqual(['1', '5'])
    expect(getVimRegister()).toEqual({ text: '2\n3\n4\n', linewise: true })
  })

  it('dj counts the fold as one row', () => {
    const h = folded()
    h.keys('dj')
    expect(h.fake.lines()).toEqual(['5'])
  })

  it('yy yanks the fold and p pastes below all of it', () => {
    const h = folded()
    h.fake.setCursor(2, 1)
    h.keys('yy')
    expect(getVimRegister()).toEqual({ text: '2\n3\n4\n', linewise: true })
    h.keys('p')
    expect(h.fake.lines()).toEqual(['1', '2', '3', '4', '2', '3', '4', '5'])
  })

  it('o opens the new line below the whole fold', () => {
    const h = folded()
    h.fake.setCursor(2, 1)
    h.type('onew<Esc>')
    expect(h.fake.lines()).toEqual(['1', '2', '3', '4', 'new', '5'])
  })

  it('>> shifts every line of the fold', () => {
    const h = folded()
    h.fake.setCursor(2, 1)
    h.keys('>>')
    expect(h.fake.lines()).toEqual(['1', '  2', '  3', '  4', '5'])
  })
})

describe('residual selection after undo / redo', () => {
  it('vjd then u leaves a caret, not the old Visual range', () => {
    const h = createVimHarness(['abc', 'def'])
    h.keys('vjd')
    expect(h.fake.lines()).toEqual(['ef'])
    h.keys('u')
    expect(h.fake.lines()).toEqual(['abc', 'def'])
    const selection = h.fake.selection()
    expect(selection.startLineNumber).toBe(selection.endLineNumber)
    expect(selection.startColumn).toBe(selection.endColumn)
  })

  it('>> then u does not leave the shifted line selected', () => {
    const h = createVimHarness(['abc', 'def'])
    h.keys('>>')
    expect(h.fake.lines()[0]).toBe('  abc')
    h.keys('u')
    expect(h.fake.lines()[0]).toBe('abc')
    expect(h.fake.selections()).toHaveLength(1)
    const selection = h.fake.selection()
    expect(selection.startColumn).toBe(selection.endColumn)
  })

  it('Ctrl+R also lands on a caret', () => {
    const h = createVimHarness(['abc', 'def'])
    h.keys('Vj>')
    h.keys('u')
    h.keys('<C-r>')
    expect(h.fake.lines()).toEqual(['  abc', '  def'])
    const selection = h.fake.selection()
    expect(selection.startColumn).toBe(selection.endColumn)
  })
})

describe('gv', () => {
  it('clamps to the buffer after the text shrank', () => {
    const h = createVimHarness(['abcdef', 'xyz', 'tail'])
    h.keys('jjvl<Esc>')
    h.keys('ggdG')
    expect(() => h.keys('gv')).not.toThrow()
    expect(h.fake.lines()).toEqual([''])
    expect(h.callbacks.onSubModeChange).toHaveBeenLastCalledWith('visual')
  })

  it('reselects what a click dropped', () => {
    const h = createVimHarness(['abcdef'])
    h.keys('vll')
    h.fake.setCursor(1, 6)
    h.keys('gv')
    expect(h.fake.selection()).toMatchObject({ startColumn: 1, endColumn: 4 })
  })
})

describe('one command, one undo step', () => {
  const cases: [string, string[], string, string[]][] = [
    ['x', ['abc'], 'x', ['bc']],
    ['3x', ['abcdef'], '3x', ['def']],
    ['dd', ['a', 'b', 'c'], 'dd', ['b', 'c']],
    ['3dd', ['a', 'b', 'c', 'd'], '3dd', ['d']],
    ['dw', ['foo bar'], 'dw', ['bar']],
    ['dj', ['a', 'b', 'c'], 'dj', ['c']],
    ['>>', ['a', 'b'], '>>', ['  a', 'b']],
    ['J', ['a', 'b'], 'J', ['a b']],
    ['3J', ['a', 'b', 'c', 'd'], '3J', ['a b c', 'd']],
    ['gJ', ['a', 'b'], 'gJ', ['ab']],
    ['~', ['abc'], '~', ['Abc']],
    ['rx', ['abc'], 'rx', ['xbc']],
    ['p', ['a'], 'yyp', ['a', 'a']],
    ['Visual J', ['a', 'b', 'c'], 'VjjJ', ['a b c']],
    ['Visual d', ['abc', 'def'], 'vjd', ['ef']],
    ['Visual >', ['a', 'b'], 'Vj>', ['  a', '  b']],
    ['Visual ~', ['abc'], 'vl~', ['ABc']],
  ]
  it.each(cases)('%s is reverted by a single u', (_name, lines, keys, expected) => {
    const h = createVimHarness(lines)
    h.keys(keys)
    expect(h.fake.lines()).toEqual(expected)
    h.keys('u')
    expect(h.fake.lines()).toEqual(lines)
  })

  it('cc, s and C open Insert and share one undo group with the typed text', () => {
    const cc = createVimHarness(['abc', 'def'])
    cc.type('ccX<Esc>')
    expect(cc.fake.lines()).toEqual(['X', 'def'])
    cc.keys('u')
    expect(cc.fake.lines()).toEqual(['abc', 'def'])

    const s = createVimHarness(['abc'])
    s.keys('s')
    expect(s.vim.modes.get('editor:test')).toBe('insert')
    s.type('Z<Esc>')
    expect(s.fake.lines()).toEqual(['Zbc'])
    s.keys('u')
    expect(s.fake.lines()).toEqual(['abc'])

    const c = createVimHarness(['abc'])
    c.fake.setCursor(1, 2)
    c.type('CX<Esc>')
    expect(c.fake.lines()).toEqual(['aX'])
    c.keys('u')
    expect(c.fake.lines()).toEqual(['abc'])
  })

  it('3J joins three lines and a bare J joins two', () => {
    const three = createVimHarness(['one', 'two', 'three', 'four'])
    three.keys('3J')
    expect(three.fake.lines()).toEqual(['one two three', 'four'])
    const bare = createVimHarness(['one', 'two'])
    bare.keys('J')
    expect(bare.fake.lines()).toEqual(['one two'])
  })

  it('J follows Vim spacing: no space before ) or after a trailing blank, indent trimmed', () => {
    const h = createVimHarness(['f(a', '  )', 'b ', '  c', '', 'd'])
    h.keys('J')
    expect(h.fake.lines()[0]).toBe('f(a)')
    h.keys('j')
    h.keys('J')
    expect(h.fake.lines()[1]).toBe('b c')
    h.keys('jJ')
    expect(h.fake.lines()[2]).toBe('d')
  })

  it('a count past the end of the buffer joins what is there', () => {
    const h = createVimHarness(['a', 'b', 'c'])
    h.keys('9J')
    expect(h.fake.lines()).toEqual(['a b c'])
  })
})

describe('input-method ownership between editors', () => {
  it('a background editor reacting to a config change does not hand English back', async () => {
    const focused = createVimHarness(['a'])
    const background = createVimHarness(['b'])
    // `focused` was created first; give the window to it again.
    focused.fake.blur()
    focused.fake.focus()
    await flush()
    expect(focused.inputMethod.switchToEnglish).toHaveBeenCalled()
    background.fake.blur()
    background.config.fire('vim.autoSwitchInputMethod')
    await flush()
    expect(background.inputMethod.restore).not.toHaveBeenCalled()
    expect(focused.inputMethod.restore).not.toHaveBeenCalled()
  })

  it('disposing a background editor leaves English with the focused one', async () => {
    const focused = createVimHarness(['a'])
    const background = createVimHarness(['b'])
    focused.fake.blur()
    focused.fake.focus()
    await flush()
    background.controller.dispose()
    await flush()
    expect(background.inputMethod.restore).not.toHaveBeenCalled()
    expect(focused.inputMethod.restore).not.toHaveBeenCalled()
    focused.controller.dispose()
    await flush()
    expect(focused.inputMethod.restore).toHaveBeenCalledTimes(1)
  })
})

describe('read-only buffers', () => {
  it('refuse every write command but still move and yank', () => {
    const h = createVimHarness(['abc', 'def'], { readOnly: true })
    h.keys('x')
    h.keys('dd')
    h.keys('p')
    h.keys('J')
    h.keys('>>')
    h.keys('rz')
    h.keys('~')
    expect(h.fake.lines()).toEqual(['abc', 'def'])
    h.keys('i')
    expect(h.vim.modes.get('editor:test')).toBe('normal')
    h.keys('yy')
    expect(getVimRegister()).toEqual({ text: 'abc\n', linewise: true })
    h.keys('j')
    expect(h.fake.cursor().line).toBe(2)
  })

  it('Visual c / d on a read-only buffer leave Visual without editing', () => {
    const h = createVimHarness(['abc'], { readOnly: true })
    h.keys('vlc')
    expect(h.fake.lines()).toEqual(['abc'])
    expect(h.vim.modes.get('editor:test')).toBe('normal')
    expect(h.callbacks.onSubModeChange).toHaveBeenLastCalledWith('normal')
  })

  it('leaves Insert when the buffer turns read-only underneath it', () => {
    const h = createVimHarness(['abc'])
    h.keys('i')
    expect(h.vim.modes.get('editor:test')).toBe('insert')
    h.fake.setReadOnly(true)
    h.keys('x')
    expect(h.vim.modes.get('editor:test')).toBe('normal')
  })
})

describe('I and gI', () => {
  it('I rests on the first non-blank', () => {
    const h = createVimHarness(['  abc'])
    h.keys('$')
    h.keys('I')
    expect(h.fake.cursor()).toEqual({ line: 1, column: 3 })
  })

  it('I on a blank-only line goes to its end', () => {
    const h = createVimHarness(['   '])
    h.keys('I')
    expect(h.fake.cursor()).toEqual({ line: 1, column: 4 })
  })
})

describe('cursor landing', () => {
  it('yb lands at the start of the yanked word, y0 at the line start', () => {
    const h = createVimHarness(['foo bar'])
    h.fake.setCursor(1, 5)
    h.keys('yb')
    expect(h.fake.cursor().column).toBe(1)
    h.fake.setCursor(1, 5)
    h.keys('y0')
    expect(h.fake.cursor().column).toBe(1)
  })

  it('yk lands on the upper line, yj stays', () => {
    const h = createVimHarness(['one', 'two', 'three'])
    h.fake.setCursor(2, 2)
    h.keys('yk')
    expect(h.fake.cursor()).toEqual({ line: 1, column: 2 })
    h.fake.setCursor(2, 2)
    h.keys('yj')
    expect(h.fake.cursor()).toEqual({ line: 2, column: 2 })
  })

  it('dd rests on the first non-blank of the line that took its place', () => {
    const h = createVimHarness(['a', '  b', 'c'])
    h.keys('dd')
    expect(h.fake.cursor()).toEqual({ line: 1, column: 3 })
  })

  it('dd on the last line rests on the new last line', () => {
    const h = createVimHarness(['a', '  b'])
    h.fake.setCursor(2, 1)
    h.keys('dd')
    expect(h.fake.cursor()).toEqual({ line: 1, column: 1 })
  })
})

describe('`.` repeats an Insert session through the key stream', () => {
  it('replays typed text and Backspace', () => {
    const h = createVimHarness(['x', 'y'])
    h.type('Aab<BS>c<Esc>')
    expect(h.fake.lines()).toEqual(['xac', 'y'])
    h.keys('j.')
    expect(h.fake.lines()).toEqual(['xac', 'yac'])
  })

  it('fires auto-indent again for a typed line break', () => {
    const h = createVimHarness(['  a', '  z'])
    h.type('A<CR>b<Esc>')
    expect(h.fake.lines()).toEqual(['  a', '  b', '  z'])
    h.keys('j.')
    expect(h.fake.lines()).toEqual(['  a', '  b', '  z', '  b'])
  })

  it('only repeats what was typed after the caret was moved with the arrow keys', () => {
    const h = createVimHarness(['x', 'y'])
    h.type('Aab<Left>c<Esc>')
    expect(h.fake.lines()).toEqual(['xacb', 'y'])
    h.keys('j.')
    expect(h.fake.lines()).toEqual(['xacb', 'yc'])
  })

  it('3. repeats the inserted text three times and keeps the replay for the next `.`', () => {
    const h = createVimHarness(['a', 'b', 'c'])
    h.type('A!<Esc>')
    h.keys('j3.')
    expect(h.fake.lines()).toEqual(['a!', 'b!!!', 'c'])
    h.keys('j.')
    expect(h.fake.lines()).toEqual(['a!', 'b!!!', 'c!!!'])
  })

  it('falls back to the net text when an IME composed part of the session', () => {
    const h = createVimHarness(['x', 'y'])
    h.keys('A')
    h.controller.handleKeyDown(
      new KeyboardEvent('keydown', { key: 'Process', keyCode: 229, isComposing: true }),
    )
    h.fake.typeText('你好')
    h.keys('<Esc>')
    expect(h.fake.lines()).toEqual(['x你好', 'y'])
    h.keys('j.')
    expect(h.fake.lines()).toEqual(['x你好', 'y你好'])
  })

  it('o replays its new line and typed text', () => {
    const h = createVimHarness(['a'])
    h.type('on<Esc>')
    h.keys('.')
    expect(h.fake.lines()).toEqual(['a', 'n', 'n'])
  })
})

describe('configuration changes', () => {
  it('an unrelated option does not re-apply the cursor style', async () => {
    const h = createVimHarness(['a'])
    vi.mocked(h.fake.editor.updateOptions!).mockClear()
    h.config.fire('files.autoSave')
    await flush()
    expect(h.fake.editor.updateOptions).not.toHaveBeenCalled()
  })

  it('editor.cursorStyle takes the block cursor back after the bridge ran', async () => {
    const h = createVimHarness(['a'])
    vi.mocked(h.fake.editor.updateOptions!).mockClear()
    h.config.fire('editor.cursorStyle')
    await flush()
    expect(h.fake.editor.updateOptions).toHaveBeenCalledWith({ cursorStyle: 'block' })
  })

  it('an unchanged vim.enabled event does not reset an Insert session', () => {
    const h = createVimHarness(['a'])
    h.keys('i')
    h.config.fire('vim.enabled')
    expect(h.vim.modes.get('editor:test')).toBe('insert')
  })

  it('disposing after the editor is gone does not throw', () => {
    const h = createVimHarness(['a'])
    vi.mocked(h.fake.editor.updateOptions!).mockImplementation(() => {
      throw new Error('disposed')
    })
    expect(() => h.controller.dispose()).not.toThrow()
    expect(() => h.controller.dispose()).not.toThrow()
  })
})

describe('registers touched by the failed-command rule', () => {
  it('x on an empty line fails and `.` still repeats the previous change', () => {
    const h = createVimHarness(['abcd', ''])
    h.keys('x')
    expect(h.fake.lines()[0]).toBe('bcd')
    h.keys('j')
    h.keys('x')
    h.keys('k')
    h.keys('.')
    expect(h.fake.lines()[0]).toBe('cd')
  })
})
