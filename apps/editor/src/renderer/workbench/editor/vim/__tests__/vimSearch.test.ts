/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it } from 'vitest'
import {
  findAllVimMatches,
  findVimMatch,
  getLastVimSearch,
  resetVimSearchForTests,
  resolveVimSearchPattern,
  setLastVimSearch,
  stripVimCaseMarkers,
  type VimSearchSource,
} from '../vimSearch.js'
import type { VimPosition, VimSearchDirection } from '../vimTypes.js'

function source(lines: string[]): VimSearchSource & { reads: number[] } {
  const reads: number[] = []
  return {
    getLineCount: () => lines.length,
    getLineContent: (line) => {
      reads.push(line)
      return lines[line - 1] ?? ''
    },
    reads,
  }
}

function at(line: number, column: number): VimPosition {
  return { line, column }
}

function find(
  lines: string[],
  from: VimPosition,
  query: string,
  direction: VimSearchDirection,
  options: { count?: number; caseSensitive?: boolean } = {},
): ReturnType<typeof findVimMatch> {
  return findVimMatch(source(lines), from, query, { direction, ...options })
}

describe('findVimMatch', () => {
  it('skips the match under the cursor for a forward search', () => {
    expect(find(['foo', 'foo'], at(1, 1), 'foo', 'forward')).toEqual({
      line: 2,
      column: 1,
      wrapped: false,
    })
  })

  it('wraps back onto the match under the cursor when it is the only one', () => {
    expect(find(['foo'], at(1, 1), 'foo', 'forward')).toEqual({
      line: 1,
      column: 1,
      wrapped: true,
    })
  })

  it('skips the match under the cursor for a backward search', () => {
    expect(find(['foo', 'foo', 'foo'], at(2, 1), 'foo', 'backward')).toEqual({
      line: 1,
      column: 1,
      wrapped: false,
    })
    expect(find(['foo'], at(1, 1), 'foo', 'backward')).toEqual({
      line: 1,
      column: 1,
      wrapped: true,
    })
  })

  it('wraps to the start and end of the file', () => {
    expect(find(['foo', 'bar'], at(2, 3), 'foo', 'forward')).toEqual({
      line: 1,
      column: 1,
      wrapped: true,
    })
    expect(find(['foo', 'bar'], at(1, 1), 'foo', 'backward')).toEqual({
      line: 1,
      column: 1,
      wrapped: true,
    })
  })

  it('is literal and case-sensitive', () => {
    expect(find(['Foo', 'foo'], at(1, 1), 'foo', 'forward')).toEqual({
      line: 2,
      column: 1,
      wrapped: false,
    })
    expect(find(['a.c', 'abc'], at(1, 1), 'a.c', 'forward')).toEqual({
      line: 1,
      column: 1,
      wrapped: true,
    })
  })

  it('walks greedy non-overlapping matches like Vim', () => {
    // `aa` in `aaaa` has match starts 1 and 3, never 2.
    expect(find(['aaaa'], at(1, 1), 'aa', 'forward')).toEqual({
      line: 1,
      column: 3,
      wrapped: false,
    })
    expect(find(['aaaa'], at(1, 3), 'aa', 'forward')).toEqual({
      line: 1,
      column: 1,
      wrapped: true,
    })
    expect(find(['aaaa'], at(1, 3), 'aa', 'backward')).toEqual({
      line: 1,
      column: 1,
      wrapped: false,
    })
    expect(find(['aaaa'], at(1, 4), 'aa', 'backward')).toEqual({
      line: 1,
      column: 3,
      wrapped: false,
    })
    expect(find(['aaa'], at(1, 1), 'aa', 'forward')).toEqual({
      line: 1,
      column: 1,
      wrapped: true,
    })
  })

  it('lets a backward search accept a match ending at the cursor', () => {
    const lines = ['x45y x45y']
    expect(find(lines, at(1, 3), '45', 'backward')).toEqual({
      line: 1,
      column: 2,
      wrapped: false,
    })
    expect(find(lines, at(1, 8), '45', 'backward')).toEqual({
      line: 1,
      column: 7,
      wrapped: false,
    })
    // Starting on the first match skips it and wraps to the last one.
    expect(find(lines, at(1, 2), '45', 'backward')).toEqual({
      line: 1,
      column: 7,
      wrapped: true,
    })
  })

  it('walks counts forward and wraps', () => {
    expect(find(['aaaaaa'], at(1, 1), 'aa', 'forward', { count: 2 })).toEqual({
      line: 1,
      column: 5,
      wrapped: false,
    })
    expect(find(['aaaaaa'], at(1, 1), 'aa', 'forward', { count: 3 })).toEqual({
      line: 1,
      column: 1,
      wrapped: true,
    })
    expect(find(['foo', 'foo', 'foo'], at(1, 1), 'foo', 'forward', { count: 4 })).toEqual({
      line: 2,
      column: 1,
      wrapped: true,
    })
  })

  it('returns null for empty queries, empty files and misses', () => {
    expect(find(['foo'], at(1, 1), '', 'forward')).toBeNull()
    expect(find([], at(1, 1), 'foo', 'forward')).toBeNull()
    expect(find(['foo'], at(1, 1), 'bar', 'forward')).toBeNull()
  })

  it('counts columns in UTF-16 code units', () => {
    expect(find(['😀foo'], at(1, 1), 'foo', 'forward')).toEqual({
      line: 1,
      column: 3,
      wrapped: false,
    })
  })

  it('stops reading once the match is found', () => {
    const lines = source(['a', 'b', 'foo', 'never'])
    expect(findVimMatch(lines, at(1, 1), 'foo', { direction: 'forward' })?.line).toBe(3)
    expect(lines.reads).toEqual([1, 2, 3])
  })

  it('detects the cycle for very large counts', () => {
    const lines = source(['foo', 'bar', 'baz'])
    expect(
      findVimMatch(lines, at(1, 1), 'foo', {
        direction: 'forward',
        count: 9_999,
      }),
    ).toEqual({ line: 1, column: 1, wrapped: true })
    expect(lines.reads.length).toBeLessThan(30)
  })

  it('resolves a count past the old step cap exactly', () => {
    // 10001 is odd: with the previous 10000-step clamp the answer would flip.
    expect(find(['foo', 'foo'], at(1, 1), 'foo', 'forward', { count: 10_001 })).toEqual({
      line: 2,
      column: 1,
      wrapped: true,
    })
  })
})

describe('last search', () => {
  beforeEach(() => resetVimSearchForTests())

  it('stores and resets the last search', () => {
    expect(getLastVimSearch()).toBeNull()
    setLastVimSearch({ text: 'foo', direction: 'backward', caseSensitive: true })
    expect(getLastVimSearch()).toEqual({ text: 'foo', direction: 'backward', caseSensitive: true })
    resetVimSearchForTests()
    expect(getLastVimSearch()).toBeNull()
  })
})

describe('case markers', () => {
  it('strips markers and keeps the last one', () => {
    expect(stripVimCaseMarkers('foo\\c')).toEqual({ text: 'foo', marker: 'c' })
    expect(stripVimCaseMarkers('foo\\C')).toEqual({ text: 'foo', marker: 'C' })
    expect(stripVimCaseMarkers('foo\\c\\C')).toEqual({ text: 'foo', marker: 'C' })
    expect(stripVimCaseMarkers('\\c')).toEqual({ text: '', marker: 'c' })
    expect(stripVimCaseMarkers('a\\b')).toEqual({ text: 'a\\b', marker: null })
  })

  it('treats a doubled backslash as a literal backslash', () => {
    expect(stripVimCaseMarkers('C:\\\\config')).toEqual({ text: 'C:\\config', marker: null })
    expect(stripVimCaseMarkers('\\\\c')).toEqual({ text: '\\c', marker: null })
    expect(stripVimCaseMarkers('\\\\')).toEqual({ text: '\\', marker: null })
  })

  it('resolves smartcase, explicit defaults and Aa overrides', () => {
    expect(resolveVimSearchPattern('foo', 'smart')).toMatchObject({
      text: 'foo',
      caseSensitive: false,
      caseSource: 'default',
    })
    expect(resolveVimSearchPattern('Foo', 'smart').caseSensitive).toBe(true)
    expect(resolveVimSearchPattern('foo', 'sensitive').caseSensitive).toBe(true)
    expect(resolveVimSearchPattern('Foo', 'insensitive').caseSensitive).toBe(false)
    expect(resolveVimSearchPattern('Foo', 'smart', 'insensitive').caseSensitive).toBe(false)
    expect(resolveVimSearchPattern('foo', 'sensitive', 'insensitive')).toMatchObject({
      caseSensitive: false,
      caseSource: 'user',
    })
  })

  it('gives an explicit marker precedence over the Aa override', () => {
    expect(resolveVimSearchPattern('Foo\\c', 'sensitive', 'sensitive')).toMatchObject({
      text: 'Foo',
      caseSensitive: false,
      caseSource: 'marker',
      marker: 'c',
    })
    expect(resolveVimSearchPattern('foo\\C', 'insensitive', 'insensitive')).toMatchObject({
      text: 'foo',
      caseSensitive: true,
      caseSource: 'marker',
      marker: 'C',
    })
  })
})

describe('case-insensitive matching', () => {
  it('matches across case only when requested', () => {
    expect(find(['Foo'], at(1, 1), 'FOO', 'forward')).toBeNull()
    expect(find(['Foo'], at(1, 1), 'FOO', 'forward', { caseSensitive: false })).toEqual({
      line: 1,
      column: 1,
      wrapped: true,
    })
  })

  it('keeps greedy non-overlap, cursor skipping, count and wrap', () => {
    expect(find(['aAaA'], at(1, 1), 'aa', 'forward', { caseSensitive: false })).toEqual({
      line: 1,
      column: 3,
      wrapped: false,
    })
    expect(
      find(['Foo', 'foo', 'FOO'], at(2, 1), 'foo', 'forward', { caseSensitive: false }),
    ).toEqual({ line: 3, column: 1, wrapped: false })
    expect(
      find(['Foo', 'foo'], at(1, 1), 'foo', 'forward', {
        caseSensitive: false,
        count: 2,
      }),
    ).toEqual({ line: 1, column: 1, wrapped: true })
  })

  it('reports UTF-16 columns and treats regex metacharacters literally', () => {
    expect(find(['😀FOO'], at(1, 1), 'foo', 'forward', { caseSensitive: false })).toEqual({
      line: 1,
      column: 3,
      wrapped: false,
    })
    expect(find(['a.c', 'abc'], at(1, 1), 'A.C', 'forward', { caseSensitive: false })).toEqual({
      line: 1,
      column: 1,
      wrapped: true,
    })
    expect(find(['[x]'], at(1, 1), '[', 'forward', { caseSensitive: false })).toEqual({
      line: 1,
      column: 1,
      wrapped: true,
    })
  })
})

describe('findAllVimMatches', () => {
  it('collects every non-overlapping match', () => {
    expect(
      findAllVimMatches(source(['foo Foo', '😀foo']), 'foo', { caseSensitive: false }),
    ).toEqual({
      matches: [
        { line: 1, column: 1, length: 3 },
        { line: 1, column: 5, length: 3 },
        { line: 2, column: 3, length: 3 },
      ],
      truncated: false,
    })
  })

  it('does not overlap repeated characters', () => {
    expect(findAllVimMatches(source(['aaaa']), 'aa', { caseSensitive: true }).matches).toEqual([
      { line: 1, column: 1, length: 2 },
      { line: 1, column: 3, length: 2 },
    ])
  })

  it('returns nothing for empty queries or files', () => {
    expect(findAllVimMatches(source(['foo']), '', { caseSensitive: true })).toEqual({
      matches: [],
      truncated: false,
    })
    expect(findAllVimMatches(source([]), 'foo', { caseSensitive: true })).toEqual({
      matches: [],
      truncated: false,
    })
  })

  it('caps matches and reports truncation', () => {
    const result = findAllVimMatches(source(['aa aa aa']), 'aa', {
      caseSensitive: true,
      maxMatches: 2,
    })
    expect(result.matches).toHaveLength(2)
    expect(result.truncated).toBe(true)
  })

  it('caps scanned lines without reading past the limit', () => {
    const lines = source(['a', 'a', 'a'])
    const result = findAllVimMatches(lines, 'a', { caseSensitive: true, maxLines: 2 })
    expect(result.matches).toHaveLength(2)
    expect(result.truncated).toBe(true)
    expect(lines.reads).toEqual([1, 2])
  })

  it('skips overlong lines and reports truncation', () => {
    expect(
      findAllVimMatches(source(['abcdef']), 'a', {
        caseSensitive: true,
        maxLineLength: 3,
      }),
    ).toEqual({ matches: [], truncated: true })
  })
})
