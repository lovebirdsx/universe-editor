/*---------------------------------------------------------------------------------------------
 *  Tests for the #-context token detection helper (promptContextRef.ts):
 *    - extractHashQuery: caret-aware tokenization (mirrors extractMentionQuery)
 *
 *  Reference serialization moved to promptRef.ts (range-tracked pills), covered
 *  by promptRef.test.ts.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { extractHashQuery } from '../promptContextRef.js'

describe('extractHashQuery', () => {
  it('returns null for an empty buffer', () => {
    expect(extractHashQuery('', 0)).toBeNull()
  })

  it('returns null when there is no # token', () => {
    expect(extractHashQuery('hello world', 5)).toBeNull()
  })

  it('detects # at start of text with empty query', () => {
    expect(extractHashQuery('#', 1)).toEqual({ query: '', startIndex: 0, endIndex: 1 })
  })

  it('detects # at start of text with partial query', () => {
    expect(extractHashQuery('#foo', 4)).toEqual({ query: 'foo', startIndex: 0, endIndex: 4 })
  })

  it('detects # after whitespace', () => {
    expect(extractHashQuery('hi #foo', 7)).toEqual({ query: 'foo', startIndex: 3, endIndex: 7 })
  })

  it('rejects mid-word # (e.g. issue-like patterns)', () => {
    expect(extractHashQuery('mail#host', 9)).toBeNull()
  })

  it('returns null when whitespace separates caret from #', () => {
    expect(extractHashQuery('#foo bar', 5)).toBeNull()
  })

  it('extends forward past the caret to the end of the token', () => {
    const r = extractHashQuery('#foobar', 4)
    expect(r).toEqual({ query: 'foobar', startIndex: 0, endIndex: 7 })
  })

  it('returns null when caret is past the end of the token', () => {
    expect(extractHashQuery('#foo', 5)).toBeNull()
  })

  it('returns null for invalid caret positions', () => {
    expect(extractHashQuery('hi', -1)).toBeNull()
    expect(extractHashQuery('hi', 99)).toBeNull()
  })
})
