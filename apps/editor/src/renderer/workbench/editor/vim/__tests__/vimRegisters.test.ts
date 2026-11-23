/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it } from 'vitest'
import {
  getVimRegister,
  isValidVimRegisterName,
  resetVimRegisterForTests,
  setVimRegister,
} from '../vimRegisters.js'

describe('vimRegisters', () => {
  beforeEach(() => resetVimRegisterForTests())

  it('stores and reads back yanked content', () => {
    expect(getVimRegister()).toBeNull()
    setVimRegister({ text: 'hello\n', linewise: true })
    expect(getVimRegister()).toEqual({ text: 'hello\n', linewise: true })
  })

  it('resets for tests', () => {
    setVimRegister({ text: 'x', linewise: false })
    resetVimRegisterForTests()
    expect(getVimRegister()).toBeNull()
  })
})

describe('vimRegisters: line endings', () => {
  beforeEach(() => resetVimRegisterForTests())

  it('stores text with \n so pasted columns do not depend on the buffer EOL', () => {
    setVimRegister({ text: 'a\r\nb\r\n', linewise: true })
    expect(getVimRegister()).toEqual({ text: 'a\nb\n', linewise: true })
  })
})

describe('vimRegisters: named, yank and black-hole registers', () => {
  beforeEach(() => resetVimRegisterForTests())

  it('writes named registers and mirrors them into the unnamed one', () => {
    setVimRegister({ text: 'a', linewise: false }, 'q')
    expect(getVimRegister('q')).toEqual({ text: 'a', linewise: false })
    expect(getVimRegister()).toEqual({ text: 'a', linewise: false })
    expect(getVimRegister('0')).toBeNull()
  })

  it('appends to a register named in uppercase, turning it linewise when either side is', () => {
    setVimRegister({ text: 'a', linewise: false }, 'q')
    setVimRegister({ text: 'b', linewise: false }, 'Q')
    expect(getVimRegister('q')).toEqual({ text: 'ab', linewise: false })
    setVimRegister({ text: 'c\n', linewise: true }, 'Q')
    expect(getVimRegister('q')).toEqual({ text: 'ab\nc\n', linewise: true })
  })

  it('"0 only follows unnamed yanks, not deletes', () => {
    setVimRegister({ text: 'y', linewise: false }, null, 'yank')
    setVimRegister({ text: 'd', linewise: false }, null, 'delete')
    expect(getVimRegister('0')).toEqual({ text: 'y', linewise: false })
    expect(getVimRegister()).toEqual({ text: 'd', linewise: false })
  })

  it('the black hole discards writes and clipboard names are not served here', () => {
    setVimRegister({ text: 'keep', linewise: false })
    expect(setVimRegister({ text: 'gone', linewise: false }, '_')).toBeNull()
    expect(getVimRegister()).toEqual({ text: 'keep', linewise: false })
    expect(getVimRegister('+')).toBeNull()
    expect(isValidVimRegisterName('+')).toBe(true)
    expect(isValidVimRegisterName('!')).toBe(false)
  })

  it('keeps the blockwise flag', () => {
    setVimRegister({ text: 'a\nb', linewise: false, blockwise: true })
    expect(getVimRegister()?.blockwise).toBe(true)
  })
})

describe('vimRegisters: numbered and small-delete registers', () => {
  beforeEach(() => resetVimRegisterForTests())

  const del = (text: string, linewise = false, name: string | null = null) =>
    setVimRegister({ text, linewise }, name, 'delete')

  it('a delete over a line break shifts "1 .. "9 and keeps "- untouched', () => {
    del('a\n', true)
    del('b\n', true)
    del('c\n', true)
    expect(getVimRegister('1')).toEqual({ text: 'c\n', linewise: true })
    expect(getVimRegister('2')).toEqual({ text: 'b\n', linewise: true })
    expect(getVimRegister('3')).toEqual({ text: 'a\n', linewise: true })
    expect(getVimRegister('-')).toBeNull()
    expect(getVimRegister('0')).toBeNull()
  })

  it('a charwise delete spanning lines also shifts the numbered registers', () => {
    del('x\ny')
    expect(getVimRegister('1')).toEqual({ text: 'x\ny', linewise: false })
    expect(getVimRegister('-')).toBeNull()
  })

  it('a small delete within one line goes to "- and leaves "1 alone', () => {
    del('word')
    expect(getVimRegister('-')).toEqual({ text: 'word', linewise: false })
    expect(getVimRegister('1')).toBeNull()
    expect(getVimRegister()).toEqual({ text: 'word', linewise: false })
  })

  it('only nine numbered registers are kept', () => {
    for (let i = 1; i <= 10; i++) del(`l${i}\n`, true)
    expect(getVimRegister('1')?.text).toBe('l10\n')
    expect(getVimRegister('9')?.text).toBe('l2\n')
  })

  it('a multi-line delete into a named register still shifts "1, a small one does not touch "-', () => {
    del('a\nb', false, 'q')
    expect(getVimRegister('q')?.text).toBe('a\nb')
    expect(getVimRegister('1')?.text).toBe('a\nb')
    del('small', false, 'q')
    expect(getVimRegister('-')).toBeNull()
  })

  it('writing "1 .. "9, "- or "0 explicitly sets exactly that register', () => {
    setVimRegister({ text: 'n3', linewise: false }, '3')
    expect(getVimRegister('3')?.text).toBe('n3')
    expect(getVimRegister('1')).toBeNull()
    setVimRegister({ text: 's', linewise: false }, '-')
    expect(getVimRegister('-')?.text).toBe('s')
    setVimRegister({ text: 'z', linewise: false }, '0')
    expect(getVimRegister('0')?.text).toBe('z')
  })

  it('"" is the unnamed register: a yank through it still fills "0', () => {
    setVimRegister({ text: 'y', linewise: false }, '"', 'yank')
    expect(getVimRegister('0')?.text).toBe('y')
    expect(getVimRegister('"')?.text).toBe('y')
    expect(getVimRegister()?.text).toBe('y')
  })

  it('accepts the digits and - as names', () => {
    for (const name of ['0', '1', '9', '-', '"', 'a', 'Z', '_']) {
      expect(isValidVimRegisterName(name), name).toBe(true)
    }
    expect(isValidVimRegisterName('10')).toBe(false)
  })
})

describe('vimRegisters: appending to a blockwise register', () => {
  beforeEach(() => resetVimRegisterForTests())

  it('keeps the block shape when a charwise piece is appended', () => {
    setVimRegister({ text: 'a\nb', linewise: false, blockwise: true }, 'q')
    setVimRegister({ text: 'c', linewise: false }, 'Q')
    expect(getVimRegister('q')).toEqual({ text: 'a\nb\nc', linewise: false, blockwise: true })
  })

  it('goes linewise when a line is appended, losing the block flag', () => {
    setVimRegister({ text: 'a\nb', linewise: false, blockwise: true }, 'q')
    setVimRegister({ text: 'c\n', linewise: true }, 'Q')
    expect(getVimRegister('q')).toEqual({ text: 'a\nb\nc\n', linewise: true })
  })
})
