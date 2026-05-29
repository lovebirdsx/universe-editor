/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for parseAnsi — SGR colour/style parsing plus strip-everything-else.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { parseAnsi } from '../ansi.js'

describe('parseAnsi', () => {
  it('passes plain text through as a single unstyled segment', () => {
    expect(parseAnsi('hello world')).toEqual([{ text: 'hello world' }])
  })

  it('returns nothing for empty input', () => {
    expect(parseAnsi('')).toEqual([])
  })

  it('parses a single foreground colour', () => {
    expect(parseAnsi('\x1b[32mgreen\x1b[0m')).toEqual([
      { text: 'green', fg: 'var(--acp-ansi-green)' },
    ])
  })

  it('parses bright foreground and background', () => {
    expect(parseAnsi('\x1b[91;100mx\x1b[0m')).toEqual([
      { text: 'x', fg: 'var(--acp-ansi-bright-red)', bg: 'var(--acp-ansi-bright-black)' },
    ])
  })

  it('parses compound style (bold + underline + colour)', () => {
    expect(parseAnsi('\x1b[1;4;34mbold\x1b[0m')).toEqual([
      { text: 'bold', fg: 'var(--acp-ansi-blue)', bold: true, underline: true },
    ])
  })

  it('resets style so later text is unstyled', () => {
    expect(parseAnsi('\x1b[31mred\x1b[0m plain')).toEqual([
      { text: 'red', fg: 'var(--acp-ansi-red)' },
      { text: ' plain' },
    ])
  })

  it('handles selective resets (22/23/24/39/49)', () => {
    expect(parseAnsi('\x1b[1;31mA\x1b[22mB\x1b[39mC')).toEqual([
      { text: 'A', fg: 'var(--acp-ansi-red)', bold: true },
      { text: 'B', fg: 'var(--acp-ansi-red)' },
      { text: 'C' },
    ])
  })

  it('parses 256-colour foreground', () => {
    // 196 = bright red in the 6x6x6 cube → rgb(255, 0, 0)
    expect(parseAnsi('\x1b[38;5;196mx')).toEqual([{ text: 'x', fg: 'rgb(255, 0, 0)' }])
  })

  it('maps low 256-colour indices to named palette', () => {
    expect(parseAnsi('\x1b[38;5;2mx')).toEqual([{ text: 'x', fg: 'var(--acp-ansi-green)' }])
  })

  it('parses truecolor foreground', () => {
    expect(parseAnsi('\x1b[38;2;10;20;30mx')).toEqual([{ text: 'x', fg: 'rgb(10, 20, 30)' }])
  })

  it('treats a bare reset (ESC[m) as full reset', () => {
    expect(parseAnsi('\x1b[31mred\x1b[mplain')).toEqual([
      { text: 'red', fg: 'var(--acp-ansi-red)' },
      { text: 'plain' },
    ])
  })

  it('strips non-SGR CSI sequences (cursor moves, clears)', () => {
    expect(parseAnsi('a\x1b[2Kb\x1b[10;5Hc')).toEqual([{ text: 'abc' }])
  })

  it('strips OSC sequences terminated by BEL', () => {
    expect(parseAnsi('\x1b]0;window title\x07done')).toEqual([{ text: 'done' }])
  })

  it('strips OSC sequences terminated by ST (ESC backslash)', () => {
    expect(parseAnsi('\x1b]0;t\x1b\\done')).toEqual([{ text: 'done' }])
  })

  it('tolerates a dangling ESC at end of input', () => {
    expect(parseAnsi('text\x1b')).toEqual([{ text: 'text' }])
  })

  it('preserves newlines inside coloured runs', () => {
    expect(parseAnsi('\x1b[32mline1\nline2\x1b[0m')).toEqual([
      { text: 'line1\nline2', fg: 'var(--acp-ansi-green)' },
    ])
  })
})
