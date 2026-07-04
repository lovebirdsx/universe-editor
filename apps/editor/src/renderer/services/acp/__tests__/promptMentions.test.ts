/*---------------------------------------------------------------------------------------------
 *  Tests for the @-mention token detection helpers (promptMentions.ts):
 *    - extractMentionQuery:     caret-aware tokenization
 *    - detectFilePickerTrigger: the @@/@# file/folder picker shortcuts
 *
 *  Reference serialization moved to promptRef.ts (range-tracked pills), covered
 *  by promptRef.test.ts.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { detectFilePickerTrigger, extractMentionQuery } from '../promptMentions.js'

describe('extractMentionQuery', () => {
  it('returns null for an empty buffer', () => {
    expect(extractMentionQuery('', 0)).toBeNull()
  })

  it('returns null when there is no @ token', () => {
    expect(extractMentionQuery('hello world', 5)).toBeNull()
  })

  it('detects @ at start of text with empty query', () => {
    const r = extractMentionQuery('@', 1)
    expect(r).toEqual({ query: '', startIndex: 0, endIndex: 1 })
  })

  it('detects @ at start of text with partial query', () => {
    const r = extractMentionQuery('@foo', 4)
    expect(r).toEqual({ query: 'foo', startIndex: 0, endIndex: 4 })
  })

  it('detects @ after whitespace', () => {
    const r = extractMentionQuery('hi @foo', 7)
    expect(r).toEqual({ query: 'foo', startIndex: 3, endIndex: 7 })
  })

  it('rejects mid-word @ (e.g. email-like patterns)', () => {
    expect(extractMentionQuery('mail@host', 9)).toBeNull()
  })

  it('returns null when caret sits before the @', () => {
    // Caret is at index 1, but @ is at index 3. Walking back hits 'i' (non-`@`,
    // non-space) — but the loop stops at the first `@` it sees. Since there's
    // no `@` between caret and start, return null.
    expect(extractMentionQuery('hi @foo', 1)).toBeNull()
  })

  it('returns null when whitespace separates caret from @', () => {
    // Caret right after the trailing space — token has been "closed".
    expect(extractMentionQuery('@foo bar', 5)).toBeNull()
  })

  it('extends forward past the caret to the end of the token', () => {
    // Caret is in the middle of "@foobar"; token range covers the full word.
    const r = extractMentionQuery('@foobar', 4)
    expect(r).toEqual({ query: 'foobar', startIndex: 0, endIndex: 7 })
  })

  it('returns null when caret is past the end of the token', () => {
    expect(extractMentionQuery('@foo', 5)).toBeNull()
  })

  it('returns null for invalid caret positions', () => {
    expect(extractMentionQuery('hi', -1)).toBeNull()
    expect(extractMentionQuery('hi', 99)).toBeNull()
  })
})

describe('detectFilePickerTrigger', () => {
  it('detects @@ as a file trigger at the caret', () => {
    expect(detectFilePickerTrigger('@@', 2)).toEqual({ kind: 'file', start: 0 })
  })

  it('detects @# as a folder trigger at the caret', () => {
    expect(detectFilePickerTrigger('@#', 2)).toEqual({ kind: 'folder', start: 0 })
  })

  it('detects the trigger after whitespace mid-buffer', () => {
    expect(detectFilePickerTrigger('review @@', 9)).toEqual({ kind: 'file', start: 7 })
    expect(detectFilePickerTrigger('review @#', 9)).toEqual({ kind: 'folder', start: 7 })
  })

  it('rejects the trigger when not preceded by a boundary (mid-word)', () => {
    expect(detectFilePickerTrigger('a@@', 3)).toBeNull()
    expect(detectFilePickerTrigger('mail@#', 6)).toBeNull()
  })

  it('only fires when the caret sits right after the two trigger chars', () => {
    // Caret before the second char — not yet a trigger.
    expect(detectFilePickerTrigger('@@', 1)).toBeNull()
    // Caret past the trigger — the user has typed further, don't re-open.
    expect(detectFilePickerTrigger('@@x', 3)).toBeNull()
  })

  it('returns null for a lone @ or other second chars', () => {
    expect(detectFilePickerTrigger('@', 1)).toBeNull()
    expect(detectFilePickerTrigger('@a', 2)).toBeNull()
  })

  it('returns null for invalid caret positions', () => {
    expect(detectFilePickerTrigger('@@', -1)).toBeNull()
    expect(detectFilePickerTrigger('@@', 99)).toBeNull()
  })
})
