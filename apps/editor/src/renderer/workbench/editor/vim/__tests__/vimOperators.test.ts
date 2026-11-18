/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { linewiseRange, resolveOperatorRange } from '../vimOperators.js'

describe('linewiseRange', () => {
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
    expect(resolveOperatorRange(threeLines, { line: 1, column: 1 }, 'j', 1, 'd')?.range).toEqual({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 3,
      endColumn: 1,
    })
    expect(resolveOperatorRange(threeLines, { line: 2, column: 1 }, 'k', 1, 'd')?.range).toEqual({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 3,
      endColumn: 1,
    })
    expect(resolveOperatorRange(threeLines, { line: 3, column: 1 }, 'gg', 0, 'd')?.range).toEqual({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 3,
      endColumn: 2,
    })
    expect(resolveOperatorRange(threeLines, { line: 1, column: 1 }, 'G', 0, 'd')?.range).toEqual({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 3,
      endColumn: 2,
    })
  })

  it('treats a count on gg/G as a line number', () => {
    const fiveLines = ['a', 'b', 'c', 'd', 'e']
    expect(resolveOperatorRange(fiveLines, { line: 5, column: 1 }, 'gg', 3, 'd')?.range).toEqual({
      startLineNumber: 2,
      startColumn: 2,
      endLineNumber: 5,
      endColumn: 2,
    })
    expect(resolveOperatorRange(fiveLines, { line: 1, column: 1 }, 'G', 3, 'd')?.range).toEqual({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 4,
      endColumn: 1,
    })
  })

  it('deletes to end of line with $', () => {
    expect(resolveOperatorRange(['abcdef'], { line: 1, column: 3 }, '$', 1, 'd')?.range).toEqual({
      startLineNumber: 1,
      startColumn: 3,
      endLineNumber: 1,
      endColumn: 7,
    })
  })

  it('treats dw as exclusive and cw as inclusive to the word end', () => {
    expect(resolveOperatorRange(['foo bar'], { line: 1, column: 1 }, 'w', 1, 'd')?.range).toEqual({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 5,
    })
    expect(resolveOperatorRange(['foo bar'], { line: 1, column: 1 }, 'w', 1, 'c')?.range).toEqual({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 4,
    })
  })

  it('treats de as inclusive and db as exclusive of the cursor', () => {
    expect(resolveOperatorRange(['foo bar'], { line: 1, column: 1 }, 'e', 1, 'd')?.range).toEqual({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 4,
    })
    expect(resolveOperatorRange(['foo bar'], { line: 1, column: 5 }, 'b', 1, 'd')?.range).toEqual({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 5,
    })
  })

  it('deletes the final word when dw has no next word start', () => {
    expect(resolveOperatorRange(['foo'], { line: 1, column: 1 }, 'w', 0, 'd')?.range).toEqual({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 4,
    })
    expect(resolveOperatorRange(['foo bar'], { line: 1, column: 5 }, 'w', 0, 'd')?.range).toEqual({
      startLineNumber: 1,
      startColumn: 5,
      endLineNumber: 1,
      endColumn: 8,
    })
  })

  it('changes only the whitespace run for cw on a blank', () => {
    expect(resolveOperatorRange(['foo   bar'], { line: 1, column: 4 }, 'w', 0, 'c')?.range).toEqual(
      {
        startLineNumber: 1,
        startColumn: 4,
        endLineNumber: 1,
        endColumn: 7,
      },
    )
  })

  it('keeps the blank paragraph line for d}/d{', () => {
    const paragraphs = ['a', '', 'b', '', 'c']
    expect(resolveOperatorRange(paragraphs, { line: 1, column: 1 }, '}', 0, 'd')?.range).toEqual({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 2,
      endColumn: 1,
    })
    expect(resolveOperatorRange(paragraphs, { line: 3, column: 1 }, '{', 0, 'd')?.range).toEqual({
      startLineNumber: 3,
      startColumn: 1,
      endLineNumber: 4,
      endColumn: 1,
    })
  })

  it('deletes to line start without including the cursor for 0/^', () => {
    expect(resolveOperatorRange(['foo bar'], { line: 1, column: 5 }, '0', 1, 'd')?.range).toEqual({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 5,
    })
    expect(resolveOperatorRange(['  abcde'], { line: 1, column: 5 }, '^', 1, 'd')?.range).toEqual({
      startLineNumber: 1,
      startColumn: 3,
      endLineNumber: 1,
      endColumn: 5,
    })
  })

  it('crosses the line break for dw at end of line', () => {
    expect(
      resolveOperatorRange(['foo', 'bar'], { line: 1, column: 1 }, 'w', 1, 'd')?.range,
    ).toEqual({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 4 })
  })

  it('returns null for paging motions', () => {
    expect(resolveOperatorRange(['a'], { line: 1, column: 1 }, 'pageDown', 1, 'd')).toBeNull()
  })
})
