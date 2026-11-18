/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it } from 'vitest'
import {
  findVimMatch,
  getLastVimSearch,
  resetVimSearchForTests,
  setLastVimSearch,
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
  options: { count?: number } = {},
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
    setLastVimSearch({ text: 'foo', direction: 'backward' })
    expect(getLastVimSearch()).toEqual({ text: 'foo', direction: 'backward' })
    resetVimSearchForTests()
    expect(getLastVimSearch()).toBeNull()
  })
})
