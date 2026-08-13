/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for packages/node-services/src/process/cmdSpawn.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { buildCmdCommandLine, quoteCmdArg } from '../cmdSpawn.js'

describe('quoteCmdArg', () => {
  it('wraps plain tokens in quotes', () => {
    expect(quoteCmdArg('code')).toBe('"code"')
  })

  it('keeps spaces literal inside quotes', () => {
    expect(quoteCmdArg('C:\\Program Files\\app\\tool.cmd')).toBe(
      '"C:\\Program Files\\app\\tool.cmd"',
    )
  })

  it('doubles embedded quotes', () => {
    expect(quoteCmdArg('say "hi"')).toBe('"say ""hi"""')
  })

  it('quotes the empty string so it survives as an argument', () => {
    expect(quoteCmdArg('')).toBe('""')
  })

  it('treats shell metacharacters as literal inside quotes', () => {
    expect(quoteCmdArg('a&b|c>d^e')).toBe('"a&b|c>d^e"')
  })
})

describe('buildCmdCommandLine', () => {
  it('wraps the whole line in outer quotes for cmd /s stripping', () => {
    expect(buildCmdCommandLine('code', ['file.txt'])).toBe('""code" "file.txt""')
  })

  it('quotes command and each arg independently', () => {
    expect(buildCmdCommandLine('npx', ['-y', 'some agent', 'say "hi"'])).toBe(
      '""npx" "-y" "some agent" "say ""hi""""',
    )
  })

  it('handles a command without args', () => {
    expect(buildCmdCommandLine('code', [])).toBe('""code""')
  })
})
