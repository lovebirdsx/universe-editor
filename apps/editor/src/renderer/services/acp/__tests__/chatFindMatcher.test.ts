/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { computeMatches } from '../chatFindMatcher.js'

describe('computeMatches', () => {
  it('returns no matches for an empty query', () => {
    expect(computeMatches('hello world', '')).toEqual([])
  })

  it('returns no matches when the query is absent', () => {
    expect(computeMatches('hello world', 'xyz')).toEqual([])
  })

  it('finds a single match with correct bounds', () => {
    expect(computeMatches('hello world', 'world')).toEqual([{ start: 6, end: 11 }])
  })

  it('finds multiple non-overlapping matches left to right', () => {
    expect(computeMatches('abababab', 'ab')).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
      { start: 4, end: 6 },
      { start: 6, end: 8 },
    ])
  })

  it('does not overlap matches', () => {
    // 'aa' in 'aaaa' yields positions 0 and 2, not 1.
    expect(computeMatches('aaaa', 'aa')).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ])
  })

  it('matches case-insensitively', () => {
    expect(computeMatches('Hello HELLO hello', 'hello')).toEqual([
      { start: 0, end: 5 },
      { start: 6, end: 11 },
      { start: 12, end: 17 },
    ])
  })

  it('handles adjacent matches', () => {
    expect(computeMatches('xx', 'x')).toEqual([
      { start: 0, end: 1 },
      { start: 1, end: 2 },
    ])
  })

  it('returns nothing when the query is longer than the haystack', () => {
    expect(computeMatches('ab', 'abc')).toEqual([])
  })

  it('matches unicode content', () => {
    expect(computeMatches('café au café', 'café')).toEqual([
      { start: 0, end: 4 },
      { start: 8, end: 12 },
    ])
  })
})
