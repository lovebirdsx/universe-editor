/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  clampNormalPosition,
  classifyChar,
  createPlainScreenOps,
  firstNonBlankColumn,
  getVimMotion,
  toLineReader,
  type VimLines,
} from '../vimMotions.js'
import type { VimMotion, VimPosition } from '../vimTypes.js'

/** Resolve a motion through the public registry, as the controller does. */
function resolveMotion(
  lines: VimLines,
  from: VimPosition,
  motion: VimMotion,
  count: number,
): VimPosition | null {
  const reader = toLineReader(lines)
  return getVimMotion(motion).resolve(
    { lines: reader, from, screen: createPlainScreenOps(reader) },
    count,
  )
}

describe('classifyChar', () => {
  it('splits blanks, keywords and punctuation', () => {
    expect(classifyChar(' ')).toBe('blank')
    expect(classifyChar('\t')).toBe('blank')
    expect(classifyChar('a')).toBe('keyword')
    expect(classifyChar('_')).toBe('keyword')
    expect(classifyChar('7')).toBe('keyword')
    expect(classifyChar('中')).toBe('keyword')
    expect(classifyChar('.')).toBe('punct')
  })
})

describe('firstNonBlankColumn', () => {
  it('finds the first non-blank column, or 1 for all-blank lines', () => {
    expect(firstNonBlankColumn('  foo')).toBe(3)
    expect(firstNonBlankColumn('foo')).toBe(1)
    expect(firstNonBlankColumn('   ')).toBe(1)
    expect(firstNonBlankColumn('')).toBe(1)
  })
})

describe('clampNormalPosition', () => {
  it('stops on the last character and clamps empty lines to column 1', () => {
    const lines = ['abc', '']
    expect(clampNormalPosition(lines, { line: 1, column: 99 })).toEqual({ line: 1, column: 3 })
    expect(clampNormalPosition(lines, { line: 2, column: 5 })).toEqual({ line: 2, column: 1 })
    expect(clampNormalPosition(lines, { line: 99, column: 1 })).toEqual({ line: 2, column: 1 })
    expect(clampNormalPosition([], { line: 1, column: 1 })).toEqual({ line: 1, column: 1 })
  })
})

describe('resolveMotion', () => {
  const lines = ['foo bar baz']

  it('moves by word (w/b/e)', () => {
    expect(resolveMotion(lines, { line: 1, column: 1 }, 'w', 1)).toEqual({ line: 1, column: 5 })
    expect(resolveMotion(lines, { line: 1, column: 1 }, 'e', 1)).toEqual({ line: 1, column: 3 })
    expect(resolveMotion(lines, { line: 1, column: 5 }, 'b', 1)).toEqual({ line: 1, column: 1 })
  })

  it('honours counts', () => {
    expect(resolveMotion(lines, { line: 1, column: 1 }, 'w', 2)).toEqual({ line: 1, column: 9 })
  })

  it('handles line-start, first-non-blank and line-end', () => {
    const indented = ['  abc  ']
    expect(resolveMotion(indented, { line: 1, column: 4 }, '0', 1)).toEqual({ line: 1, column: 1 })
    expect(resolveMotion(indented, { line: 1, column: 1 }, '^', 1)).toEqual({ line: 1, column: 3 })
    expect(resolveMotion(indented, { line: 1, column: 1 }, '$', 1)).toEqual({ line: 1, column: 7 })
  })

  it('drops N-1 lines before a counted $', () => {
    const multi = ['abc', 'defgh', 'ij']
    expect(resolveMotion(multi, { line: 1, column: 1 }, '$', 2)).toEqual({ line: 2, column: 5 })
    expect(resolveMotion(multi, { line: 2, column: 1 }, '$', 3)).toEqual({ line: 3, column: 2 })
    // A count past EOF stays on the last line instead of overshooting.
    expect(resolveMotion(multi, { line: 1, column: 1 }, '$', 9)).toEqual({ line: 3, column: 2 })
  })

  it('clamps vertical movement to line bounds', () => {
    const multi = ['abcdef', 'xy']
    expect(resolveMotion(multi, { line: 1, column: 6 }, 'j', 1)).toEqual({ line: 2, column: 2 })
    expect(resolveMotion(multi, { line: 2, column: 1 }, 'k', 1)).toEqual({ line: 1, column: 1 })
  })

  it('resolves gg/G to the first/last line', () => {
    const multi = ['  first', 'middle', 'last']
    expect(resolveMotion(multi, { line: 2, column: 1 }, 'gg', 0)).toEqual({ line: 1, column: 3 })
    expect(resolveMotion(multi, { line: 2, column: 1 }, 'G', 0)).toEqual({ line: 3, column: 1 })
  })

  it('treats a count on gg/G as a line number', () => {
    const multi = ['  first', 'middle', 'last']
    expect(resolveMotion(multi, { line: 1, column: 1 }, 'G', 2)).toEqual({ line: 2, column: 1 })
    expect(resolveMotion(multi, { line: 3, column: 1 }, 'gg', 2)).toEqual({ line: 2, column: 1 })
  })

  it('crosses lines for word motions', () => {
    const multi = ['foo', 'bar']
    expect(resolveMotion(multi, { line: 1, column: 1 }, 'w', 1)).toEqual({ line: 2, column: 1 })
  })

  it('treats CJK runs as words', () => {
    const cjk = ['中文 测试']
    expect(resolveMotion(cjk, { line: 1, column: 1 }, 'w', 1)).toEqual({ line: 1, column: 4 })
  })

  it('moves by paragraph with { and }', () => {
    const paragraphs = ['a', '', 'b', '', 'c']
    expect(resolveMotion(paragraphs, { line: 1, column: 1 }, '}', 1)).toEqual({
      line: 2,
      column: 1,
    })
    expect(resolveMotion(paragraphs, { line: 5, column: 1 }, '{', 1)).toEqual({
      line: 4,
      column: 1,
    })
  })

  it("moves with <CR> to the next line's first non-blank and stops at EOF", () => {
    const multi = ['abc', '  def', 'last']
    expect(resolveMotion(multi, { line: 1, column: 3 }, 'enter', 0)).toEqual({
      line: 2,
      column: 3,
    })
    expect(resolveMotion(multi, { line: 1, column: 1 }, 'enter', 2)).toEqual({
      line: 3,
      column: 1,
    })
    expect(resolveMotion(multi, { line: 3, column: 2 }, 'enter', 1)).toEqual({
      line: 3,
      column: 2,
    })
  })

  it('returns null for paging motions (the controller hands those to Monaco)', () => {
    expect(resolveMotion(lines, { line: 1, column: 1 }, 'pageDown', 1)).toBeNull()
    expect(resolveMotion(lines, { line: 1, column: 1 }, 'halfPageUp', 1)).toBeNull()
  })
})

describe('resolveMotion: empty lines and word boundaries', () => {
  const lines = ['foo', '', 'bar']

  it('stops w on an empty line, as Vim does', () => {
    expect(resolveMotion(lines, { line: 1, column: 1 }, 'w', 1)).toEqual({ line: 2, column: 1 })
    expect(resolveMotion(lines, { line: 2, column: 1 }, 'w', 1)).toEqual({ line: 3, column: 1 })
  })

  it('stops b on an empty line', () => {
    expect(resolveMotion(lines, { line: 3, column: 1 }, 'b', 1)).toEqual({ line: 2, column: 1 })
    expect(resolveMotion(lines, { line: 2, column: 1 }, 'b', 1)).toEqual({ line: 1, column: 1 })
  })

  it('skips an empty line with e (it has no word end)', () => {
    expect(resolveMotion(lines, { line: 1, column: 3 }, 'e', 1)).toEqual({ line: 3, column: 3 })
  })

  it('treats a run of blank-only lines as separate empty-line words only for w/b', () => {
    const blanks = ['a', '', '', 'b']
    expect(resolveMotion(blanks, { line: 1, column: 1 }, 'w', 2)).toEqual({ line: 3, column: 1 })
  })

  it('treats W like w but over whitespace-delimited words', () => {
    const text = ['foo.bar baz']
    expect(resolveMotion(text, { line: 1, column: 1 }, 'W', 1)).toEqual({ line: 1, column: 9 })
    expect(resolveMotion(text, { line: 1, column: 1 }, 'w', 1)).toEqual({ line: 1, column: 4 })
  })
})
