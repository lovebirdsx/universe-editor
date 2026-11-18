/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it } from 'vitest'
import { getVimRegister, resetVimRegisterForTests, setVimRegister } from '../vimRegisters.js'

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
