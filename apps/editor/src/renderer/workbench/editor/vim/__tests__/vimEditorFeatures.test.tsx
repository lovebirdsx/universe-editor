/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetVimRegisterForTests, getVimRegister } from '../vimRegisters.js'
import { resetVimSessionForTests } from '../vimSession.js'
import { createVimHarness } from './fakeVimEditor.js'

beforeEach(() => {
  resetVimRegisterForTests()
  resetVimSessionForTests()
})

describe('text objects through operators', () => {
  it('diw / daw / ciw', () => {
    const h = createVimHarness(['foo bar baz'])
    h.fake.setCursor(1, 5)
    h.keys('diw')
    expect(h.fake.lines()).toEqual(['foo  baz'])
    h.fake.setCursor(1, 1)
    h.keys('daw')
    expect(h.fake.lines()).toEqual(['baz'])
    h.fake.setCursor(1, 2)
    h.keys('ciw')
    expect(h.vim.modes.get('editor:test')).toBe('insert')
    h.fake.typeText('X')
    h.keys('<Esc>')
    expect(h.fake.lines()).toEqual(['X'])
  })

  it('operates on quotes, brackets and tags', () => {
    const h = createVimHarness(['say "hello world" now'])
    h.fake.setCursor(1, 8)
    h.keys('di"')
    expect(h.fake.lines()).toEqual(['say "" now'])
    const b = createVimHarness(['f(a, (b), c)'])
    b.fake.setCursor(1, 6)
    b.keys('da(')
    expect(b.fake.lines()).toEqual(['f(a, , c)'])
    const c = createVimHarness(['f(a, (b), c)'])
    c.fake.setCursor(1, 6)
    c.keys('d2ib')
    expect(c.fake.lines()).toEqual(['f()'])
    const t = createVimHarness(['<div><b>x</b></div>'])
    t.fake.setCursor(1, 9)
    t.keys('dit')
    expect(t.fake.lines()).toEqual(['<div><b></b></div>'])
  })

  it('operates on paragraphs and braces spanning lines', () => {
    const h = createVimHarness(['a', 'b', '', 'c'])
    h.keys('dip')
    expect(h.fake.lines()).toEqual(['', 'c'])
    const b = createVimHarness(['if (x) {', '  one', '  two', '}'])
    b.fake.setCursor(1, 8)
    b.keys('di{')
    expect(b.fake.lines()).toEqual(['if (x) {', '}'])
  })

  it('yanks an object into the register and fails quietly when none exists', () => {
    const h = createVimHarness(['foo bar'])
    h.fake.setCursor(1, 5)
    h.keys('yiw')
    expect(getVimRegister()).toEqual({ text: 'bar', linewise: false })
    h.keys('di"')
    expect(h.fake.lines()).toEqual(['foo bar'])
    expect(h.callbacks.onUnsupportedKey).not.toHaveBeenCalled()
  })
})

describe('find motions, %, and simple commands', () => {
  it('f / F / t / T, then ; and ,', () => {
    const h = createVimHarness(['a,b,c,d'])
    h.keys('f,')
    expect(h.fake.cursor().column).toBe(2)
    h.keys(';')
    expect(h.fake.cursor().column).toBe(4)
    h.keys(',')
    expect(h.fake.cursor().column).toBe(2)
    h.keys('t,')
    expect(h.fake.cursor().column).toBe(3)
    h.fake.setCursor(1, 7)
    h.keys('F,')
    expect(h.fake.cursor().column).toBe(6)
    h.keys('T,')
    expect(h.fake.cursor().column).toBe(5)
  })

  it('works with operators and counts: dt, d2f', () => {
    const h = createVimHarness(['a,b,c,d'])
    h.keys('dt,')
    expect(h.fake.lines()).toEqual([',b,c,d'])
    h.keys('d2f,')
    expect(h.fake.lines()).toEqual(['d'])
  })

  it('% jumps to the matching bracket and d% deletes through it', () => {
    const h = createVimHarness(['x(a[b]c)y'])
    h.fake.setCursor(1, 2)
    h.keys('%')
    expect(h.fake.cursor().column).toBe(8)
    h.keys('%')
    expect(h.fake.cursor().column).toBe(2)
    h.keys('d%')
    expect(h.fake.lines()).toEqual(['xy'])
  })

  it('r{char} replaces, 3r{char} replaces several, ~ toggles case', () => {
    const h = createVimHarness(['hello'])
    h.keys('rj')
    expect(h.fake.lines()).toEqual(['jello'])
    h.keys('3rx')
    expect(h.fake.lines()).toEqual(['xxxlo'])
    h.keys('~')
    expect(h.fake.lines()).toEqual(['xxXlo'])
  })

  it('toggles case and advances with ~', () => {
    const h = createVimHarness(['abc'])
    h.keys('2~')
    expect(h.fake.lines()).toEqual(['ABc'])
    expect(h.fake.cursor().column).toBe(3)
  })

  it('X deletes backward, D deletes to end, Y yanks the line', () => {
    const h = createVimHarness(['abcd', 'next'])
    h.fake.setCursor(1, 3)
    h.keys('X')
    expect(h.fake.lines()[0]).toBe('acd')
    h.keys('D')
    expect(h.fake.lines()[0]).toBe('a')
    h.keys('Y')
    expect(getVimRegister()).toEqual({ text: 'a\n', linewise: true })
  })

  it('J joins with a space, gJ without', () => {
    const h = createVimHarness(['a', '  b', 'c'])
    h.keys('J')
    expect(h.fake.lines()).toEqual(['a b', 'c'])
    h.keys('gJ')
    expect(h.fake.lines()).toEqual(['a bc'])
  })

  it('redoes through Ctrl+R: u undoes the change, Ctrl+R puts it back', () => {
    const h = createVimHarness(['abc'])
    h.keys('x')
    expect(h.fake.lines()).toEqual(['bc'])
    h.keys('u')
    expect(h.fake.lines()).toEqual(['abc'])
    h.keys('<C-r>')
    expect(h.fake.lines()).toEqual(['bc'])
  })
})

describe('registers', () => {
  it('"ayy / "ap, uppercase appends, "0 keeps the last yank, "_ discards', () => {
    const h = createVimHarness(['one', 'two'])
    h.keys('"ayy')
    h.keys('j"Ayy')
    expect(getVimRegister('a')).toEqual({ text: 'one\ntwo\n', linewise: true })
    h.keys('yy')
    h.keys('dd')
    expect(getVimRegister('0')).toEqual({ text: 'two\n', linewise: true })
    expect(getVimRegister()).toEqual({ text: 'two\n', linewise: true })
    h.keys('"_dd')
    expect(getVimRegister()).toEqual({ text: 'two\n', linewise: true })
    expect(h.fake.lines()).toEqual([''])
    h.keys('"ap')
    expect(h.fake.lines()).toEqual(['', 'one', 'two'])
  })

  it('keeps named registers apart from the unnamed one', () => {
    const h = createVimHarness(['abc def'])
    h.keys('"qyiw')
    h.keys('wyiw')
    h.keys('"qP')
    expect(h.fake.lines()).toEqual(['abc abcdef'])
  })

  it('mirrors yanks to the system clipboard for "+ and, when configured, for the unnamed register', async () => {
    const writes: string[] = []
    const clipboard = {
      readText: vi.fn(async () => 'from clipboard'),
      writeText: vi.fn(async (text: string) => {
        writes.push(text)
      }),
    }
    const h = createVimHarness(['abc'], { controller: { clipboard } })
    h.keys('"+yiw')
    expect(writes).toEqual(['abc'])
    h.keys('yiw')
    expect(writes).toEqual(['abc'])
    h.config.set('vim.useSystemClipboard', true)
    h.config.fire('vim.useSystemClipboard')
    h.keys('yiw')
    expect(writes).toEqual(['abc', 'abc'])
    h.keys('"+p')
    await vi.waitFor(() => expect(h.fake.lines()).toEqual(['afrom clipboardbc']))
  })

  it('pastes the clipboard for the unnamed register when vim.useSystemClipboard is on', async () => {
    const clipboard = {
      readText: vi.fn(async () => 'EXT'),
      writeText: vi.fn(async () => undefined),
    }
    const h = createVimHarness(['ab'], {
      config: { 'vim.useSystemClipboard': true },
      controller: { clipboard },
    })
    h.keys('p')
    await vi.waitFor(() => expect(h.fake.lines()).toEqual(['aEXTb']))
  })
})

describe('dot repeat', () => {
  it('repeats an operator with a text object', () => {
    const h = createVimHarness(['a b c d'])
    h.keys('daw')
    h.keys('.')
    expect(h.fake.lines()).toEqual(['c d'])
    h.keys('.')
    expect(h.fake.lines()).toEqual(['d'])
  })

  it('3. replaces the count', () => {
    const h = createVimHarness(['a b c d e f'])
    h.keys('dw')
    h.keys('3.')
    expect(h.fake.lines()).toEqual(['e f'])
    h.keys('.')
    expect(h.fake.lines()).toEqual([''])
  })

  it('repeats x, p, ~, r, J, >> and dd', () => {
    const h = createVimHarness(['abcdef'])
    h.keys('x.')
    expect(h.fake.lines()).toEqual(['cdef'])
    h.keys('rZ')
    h.keys('l.')
    expect(h.fake.lines()).toEqual(['ZZef'])
    const j = createVimHarness(['a', 'b', 'c', 'd'])
    j.keys('J')
    j.keys('.')
    expect(j.fake.lines()).toEqual(['a b c', 'd'])
    const d = createVimHarness(['1', '2', '3'])
    d.keys('dd.')
    expect(d.fake.lines()).toEqual(['3'])
  })

  it('replays the typed Insert text', () => {
    const h = createVimHarness(['x', 'y'])
    h.keys('A')
    h.fake.typeText('!!')
    h.keys('<Esc>')
    expect(h.fake.lines()).toEqual(['x!!', 'y'])
    h.keys('j.')
    expect(h.fake.lines()).toEqual(['x!!', 'y!!'])
    expect(h.vim.modes.get('editor:test')).toBe('normal')
  })

  it('replays cw with its typed text and o with its new line', () => {
    const h = createVimHarness(['foo bar baz'])
    h.keys('cw')
    h.fake.typeText('X')
    h.keys('<Esc>')
    expect(h.fake.lines()).toEqual(['X bar baz'])
    h.keys('w.')
    expect(h.fake.lines()).toEqual(['X X baz'])
    const o = createVimHarness(['a'])
    o.keys('o')
    o.fake.typeText('n')
    o.keys('<Esc>')
    o.keys('.')
    expect(o.fake.lines()).toEqual(['a', 'n', 'n'])
  })

  it('repeats a counted insert text', () => {
    const h = createVimHarness([''])
    h.keys('3i')
    h.fake.typeText('ab')
    h.keys('<Esc>')
    expect(h.fake.lines()).toEqual(['ababab'])
  })

  it('does not record yanks or motions as changes', () => {
    const h = createVimHarness(['a b c'])
    h.keys('dw')
    h.keys('yw')
    h.keys('w')
    h.keys('.')
    expect(h.fake.lines()).toEqual(['b '])
  })
})
