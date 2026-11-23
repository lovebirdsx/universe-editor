/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { linewiseOperatorRange, resolveOperatorRange } from '../vimOperators.js'
import type { VimScreenOps } from '../vimMotions.js'

const linewiseRange = (lines: string[], start: number, end: number) =>
  linewiseOperatorRange(lines, start, end).range

describe('linewise ranges', () => {
  it('includes the trailing break for a middle line', () => {
    expect(linewiseRange(['a', 'b', 'c'], 1, 1)).toEqual({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 2,
      endColumn: 1,
    })
  })

  it('removes the leading break at EOF', () => {
    expect(linewiseRange(['a', 'b'], 2, 2)).toEqual({
      startLineNumber: 1,
      startColumn: 2,
      endLineNumber: 2,
      endColumn: 2,
    })
  })

  it('spans the whole single-line file', () => {
    expect(linewiseRange(['abc'], 1, 1)).toEqual({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 4,
    })
  })
})

describe('resolveOperatorRange', () => {
  const threeLines = ['a', 'b', 'c']

  it('builds linewise ranges for j/k/gg/G', () => {
    expect(resolveOperatorRange(threeLines, { line: 1, column: 1 }, 'j', 1)?.range).toEqual({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 3,
      endColumn: 1,
    })
    expect(resolveOperatorRange(threeLines, { line: 2, column: 1 }, 'k', 1)?.range).toEqual({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 3,
      endColumn: 1,
    })
    expect(resolveOperatorRange(threeLines, { line: 3, column: 1 }, 'gg', 0)?.range).toEqual({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 3,
      endColumn: 2,
    })
    expect(resolveOperatorRange(threeLines, { line: 1, column: 1 }, 'G', 0)?.range).toEqual({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 3,
      endColumn: 2,
    })
  })

  it('treats a count on gg/G as a line number', () => {
    const fiveLines = ['a', 'b', 'c', 'd', 'e']
    expect(resolveOperatorRange(fiveLines, { line: 5, column: 1 }, 'gg', 3)?.range).toEqual({
      startLineNumber: 2,
      startColumn: 2,
      endLineNumber: 5,
      endColumn: 2,
    })
    expect(resolveOperatorRange(fiveLines, { line: 1, column: 1 }, 'G', 3)?.range).toEqual({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 4,
      endColumn: 1,
    })
  })

  it('deletes to end of line with $', () => {
    expect(resolveOperatorRange(['abcdef'], { line: 1, column: 3 }, '$', 1)?.range).toEqual({
      startLineNumber: 1,
      startColumn: 3,
      endLineNumber: 1,
      endColumn: 7,
    })
  })

  it('deletes through the next line end for a counted $', () => {
    expect(resolveOperatorRange(['abc', 'defgh'], { line: 1, column: 1 }, '$', 2)?.range).toEqual({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 2,
      endColumn: 6,
    })
  })

  it('treats dw as exclusive of the next word start', () => {
    expect(resolveOperatorRange(['foo bar'], { line: 1, column: 1 }, 'w', 1)?.range).toEqual({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 5,
    })
  })

  it('treats de as inclusive and db as exclusive of the cursor', () => {
    expect(resolveOperatorRange(['foo bar'], { line: 1, column: 1 }, 'e', 1)?.range).toEqual({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 4,
    })
    expect(resolveOperatorRange(['foo bar'], { line: 1, column: 5 }, 'b', 1)?.range).toEqual({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 5,
    })
  })

  it('deletes the final word when dw has no next word start', () => {
    expect(resolveOperatorRange(['foo'], { line: 1, column: 1 }, 'w', 0)?.range).toEqual({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 4,
    })
    expect(resolveOperatorRange(['foo bar'], { line: 1, column: 5 }, 'w', 0)?.range).toEqual({
      startLineNumber: 1,
      startColumn: 5,
      endLineNumber: 1,
      endColumn: 8,
    })
  })

  it('makes d} linewise from the start of a paragraph and spares the blank line', () => {
    const paragraphs = ['a', '', 'b', '', 'c']
    expect(resolveOperatorRange(paragraphs, { line: 1, column: 1 }, '}', 0)).toMatchObject({
      linewise: true,
      range: { startLineNumber: 1, startColumn: 1, endLineNumber: 2, endColumn: 1 },
    })
  })

  it('makes d{ on the first line after a blank take that blank line (Vim exclusive-to-linewise)', () => {
    const paragraphs = ['a', '', 'b', '', 'c']
    expect(resolveOperatorRange(paragraphs, { line: 3, column: 1 }, '{', 0)).toMatchObject({
      linewise: true,
      range: { startLineNumber: 2, startColumn: 1, endLineNumber: 3, endColumn: 1 },
    })
  })

  it('keeps d} charwise from the middle of a line: only up to the end of the paragraph', () => {
    const lines = ['abc def', 'ghi', '', 'x']
    expect(resolveOperatorRange(lines, { line: 1, column: 5 }, '}', 0)).toMatchObject({
      linewise: false,
      range: { startLineNumber: 1, startColumn: 5, endLineNumber: 2, endColumn: 4 },
    })
    expect(resolveOperatorRange(lines, { line: 1, column: 5 }, '}', 0, 'y')?.linewise).toBe(false)
    expect(resolveOperatorRange(lines, { line: 1, column: 5 }, '}', 0, 'c')?.linewise).toBe(false)
  })

  it('keeps d{ charwise when the cursor is mid-line: from the blank line to the cursor', () => {
    const lines = ['a', '', 'bcd']
    expect(resolveOperatorRange(lines, { line: 3, column: 3 }, '{', 0)).toMatchObject({
      linewise: false,
      range: { startLineNumber: 2, startColumn: 1, endLineNumber: 3, endColumn: 3 },
    })
  })

  it('d} with no blank line below runs to the last character, inclusive', () => {
    expect(resolveOperatorRange(['ab', 'cd'], { line: 1, column: 2 }, '}', 0)?.range).toEqual({
      startLineNumber: 1,
      startColumn: 2,
      endLineNumber: 2,
      endColumn: 3,
    })
  })

  it('counts paragraphs: 2} skips the first blank run, and fails past the buffer', () => {
    const lines = ['a', '', 'b', '', 'c']
    expect(resolveOperatorRange(lines, { line: 1, column: 1 }, '}', 2)?.range).toEqual({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 4,
      endColumn: 1,
    })
    expect(resolveOperatorRange(lines, { line: 1, column: 1 }, '}', 4)).toBeNull()
  })

  it('deletes to line start without including the cursor for 0/^', () => {
    expect(resolveOperatorRange(['foo bar'], { line: 1, column: 5 }, '0', 1)?.range).toEqual({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 5,
    })
    expect(resolveOperatorRange(['  abcde'], { line: 1, column: 5 }, '^', 1)?.range).toEqual({
      startLineNumber: 1,
      startColumn: 3,
      endLineNumber: 1,
      endColumn: 5,
    })
  })

  it('crosses the line break for dw at end of line', () => {
    expect(resolveOperatorRange(['foo', 'bar'], { line: 1, column: 1 }, 'w', 1)?.range).toEqual({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 4,
    })
  })

  it('returns null for paging motions', () => {
    expect(resolveOperatorRange(['a'], { line: 1, column: 1 }, 'pageDown', 1)).toBeNull()
  })
})

describe('resolveOperatorRange: cw / cW / dh / dl / > / <', () => {
  const origin = { line: 1, column: 1 }
  const single = (startColumn: number, endColumn: number) => ({
    startLineNumber: 1,
    startColumn,
    endLineNumber: 1,
    endColumn,
  })

  it('makes cw on a non-blank act like ce and keep the trailing blank', () => {
    expect(resolveOperatorRange(['foo bar'], origin, 'w', 1, 'c')?.range).toEqual(single(1, 4))
    expect(resolveOperatorRange(['foo bar'], { line: 1, column: 2 }, 'w', 1, 'c')?.range).toEqual(
      single(2, 4),
    )
    // d keeps the plain exclusive dw range.
    expect(resolveOperatorRange(['foo bar'], origin, 'w', 1, 'd')?.range).toEqual(single(1, 5))
  })

  it('honours a count and the big-word variant for cw / cW', () => {
    expect(resolveOperatorRange(['foo bar baz'], origin, 'w', 2, 'c')?.range).toEqual(single(1, 8))
    expect(resolveOperatorRange(['a.b c'], origin, 'W', 1, 'c')?.range).toEqual(single(1, 4))
    expect(resolveOperatorRange(['a.b c'], origin, 'w', 1, 'c')?.range).toEqual(single(1, 2))
  })

  it('keeps cw on a blank as a plain word-forward change', () => {
    expect(resolveOperatorRange(['a   b'], { line: 1, column: 2 }, 'w', 1, 'c')?.range).toEqual(
      single(2, 5),
    )
  })

  it('handles dh and dl, including dl on the last character', () => {
    expect(resolveOperatorRange(['abc'], { line: 1, column: 3 }, 'h', 1)?.range).toEqual(
      single(2, 3),
    )
    expect(resolveOperatorRange(['abc'], { line: 1, column: 1 }, 'l', 2)?.range).toEqual(
      single(1, 3),
    )
    expect(resolveOperatorRange(['abc'], { line: 1, column: 3 }, 'l', 1)?.range).toEqual(
      single(3, 4),
    )
    expect(resolveOperatorRange(['abc'], { line: 1, column: 1 }, 'h', 1)).toBeNull()
  })

  it('does not stall or cross lines on dl over an empty line', () => {
    expect(resolveOperatorRange(['', 'x'], origin, 'l', 1)).toBeNull()
  })

  it('treats > and < as linewise operators over j', () => {
    for (const operator of ['>', '<'] as const) {
      const target = resolveOperatorRange(['a', 'b', 'c'], origin, 'j', 1, operator)
      expect(target?.linewise).toBe(true)
      expect(target?.range.startLineNumber).toBe(1)
    }
  })
})

describe('resolveOperatorRange: display-line motions', () => {
  function displayScreen(position: { line: number; column: number }): VimScreenOps {
    return {
      advanceRows: (line, delta, steps) => line + delta * steps,
      wrapsLines: () => true,
      advanceDisplayRows: () => ({ position, moved: true }),
    }
  }

  it('is linewise without a display geometry (wrap off behaves like j/k)', () => {
    expect(
      resolveOperatorRange(['abcdef', 'abcdef', 'tail'], { line: 1, column: 3 }, 'gj', 1)?.range,
    ).toEqual({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 3,
      endColumn: 1,
    })
  })

  it('is characterwise exclusive with wrapping on', () => {
    const range = resolveOperatorRange(
      ['abcdefghij'],
      { line: 1, column: 3 },
      'gj',
      1,
      'd',
      {},
      displayScreen({ line: 1, column: 8 }),
    )
    expect(range).toMatchObject({
      linewise: false,
      range: { startLineNumber: 1, startColumn: 3, endLineNumber: 1, endColumn: 8 },
    })
  })

  it('lets the o_v rule promote a display row ending in column 1 to linewise', () => {
    const range = resolveOperatorRange(
      ['  abc', 'def'],
      { line: 1, column: 2 },
      'gj',
      1,
      'd',
      {},
      displayScreen({ line: 2, column: 1 }),
    )
    expect(range?.linewise).toBe(true)
    // The o_v rule stops at the end of the previous line (line 1), not line 2.
    expect(range?.range).toEqual({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 2,
      endColumn: 1,
    })
  })

  it('fails when the display geometry cannot move', () => {
    const screen: VimScreenOps = {
      advanceRows: (line, delta, steps) => line + delta * steps,
      wrapsLines: () => true,
      advanceDisplayRows: () => ({ position: { line: 1, column: 3 }, moved: false }),
    }
    expect(
      resolveOperatorRange(['abcdefghij'], { line: 1, column: 3 }, 'gj', 1, 'd', {}, screen),
    ).toBeNull()
  })
})
