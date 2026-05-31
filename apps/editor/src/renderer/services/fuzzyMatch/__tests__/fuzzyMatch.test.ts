/*---------------------------------------------------------------------------------------------
 *  Tests for the shared fuzzy / word matching primitives reused by Go to File,
 *  the slash-command popover, and the @-mention popover.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { fuzzyMatchField, scoreFuzzyMatch, wordMatchField } from '../fuzzyMatch.js'

describe('fuzzyMatchField', () => {
  it('matches the full text for an empty query', () => {
    expect(fuzzyMatchField('anything', '')).toBe(true)
  })

  it('matches a contiguous substring', () => {
    expect(fuzzyMatchField('main.ts', 'main')).toBe(true)
  })

  it('matches a non-contiguous subsequence', () => {
    expect(fuzzyMatchField('components/main.tsx', 'cmtsx')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(fuzzyMatchField('README.md', 'readme')).toBe(true)
    expect(fuzzyMatchField('readme.md', 'README')).toBe(true)
  })

  it('fails when characters are out of order', () => {
    expect(fuzzyMatchField('abc', 'cba')).toBe(false)
  })

  it('fails when a query character is missing', () => {
    expect(fuzzyMatchField('main.ts', 'mainz')).toBe(false)
  })
})

describe('scoreFuzzyMatch', () => {
  it('scores an empty query as a neutral match', () => {
    expect(scoreFuzzyMatch('anything', '')).toBe(0)
  })

  it('ranks prefix above substring above subsequence', () => {
    const prefix = scoreFuzzyMatch('compact', 'compact')
    const substring = scoreFuzzyMatch('do-compact-now', 'compact')
    const subseq = scoreFuzzyMatch('c-o-m-p-a-c-t', 'compact')
    expect(prefix).toBeGreaterThan(substring)
    expect(substring).toBeGreaterThan(subseq)
  })

  it('prefers shorter fields within the same tier', () => {
    expect(scoreFuzzyMatch('main.ts', 'main')).toBeGreaterThan(
      scoreFuzzyMatch('main.test.ts', 'main'),
    )
  })

  it('returns -1 when there is no match', () => {
    expect(scoreFuzzyMatch('compact', 'zzz')).toBe(-1)
  })
})

describe('wordMatchField', () => {
  it('matches the full text for an empty query', () => {
    expect(wordMatchField('anything', '')).toBe(true)
  })

  it('matches a plain substring', () => {
    expect(wordMatchField('open recent file', 'recent')).toBe(true)
  })

  it('matches space-separated word pieces at word boundaries', () => {
    expect(wordMatchField('Open Recent File', 'open file')).toBe(true)
  })

  it('matches compact word starts', () => {
    expect(wordMatchField('Quick Open Panel', 'qop')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(wordMatchField('Toggle Side Bar', 'TOGGLE')).toBe(true)
  })

  it('fails when a word piece is absent', () => {
    expect(wordMatchField('open recent file', 'open close')).toBe(false)
  })
})
