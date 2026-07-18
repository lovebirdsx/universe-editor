/*---------------------------------------------------------------------------------------------
 *  Tests for the shared fuzzy / word matching primitives reused by Go to File,
 *  the slash-command popover, and the @-mention popover.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  compareByScoreThenPath,
  fuzzyMatchField,
  fuzzyScore,
  scoreFuzzyMatch,
  wordMatchField,
} from '../text/fuzzyMatch.js'

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

describe('fuzzyScore', () => {
  it('treats an empty query as a neutral match with no highlights', () => {
    expect(fuzzyScore('anything', '')).toEqual({ score: 0, matches: [] })
  })

  it('returns null when there is no match', () => {
    expect(fuzzyScore('compact', 'zzz')).toBeNull()
  })

  it('highlights a prefix match as one span', () => {
    expect(fuzzyScore('GetEntityData', 'GetEntity')?.matches).toEqual([{ start: 0, end: 9 }])
  })

  it('highlights a substring match as one span', () => {
    expect(fuzzyScore('AsyncGetEntityData', 'GetEntity')?.matches).toEqual([{ start: 5, end: 14 }])
  })

  it('merges adjacent subsequence hits into contiguous spans', () => {
    const res = fuzzyScore('a_bc_d', 'bcd')
    expect(res?.matches).toEqual([
      { start: 2, end: 4 },
      { start: 5, end: 6 },
    ])
  })

  // The bug report: '@:GetEntityData' must rank the exact name on top, not bury
  // it alphabetically between AsyncGet… and GetAbandoned… entries.
  it('ranks the exact symbol name above longer fuzzy matches', () => {
    const candidates = [
      'AsyncGetAbandonedEntityDataRecords',
      'GetAbandonedEntityDataRecords',
      'GetDuplicateEntityDataRecords',
      'GetEntityData',
      'GetEntityDataByWpPath',
      'GetEntityDataPath',
    ]
    const ranked = candidates
      .map((name) => ({ name, score: fuzzyScore(name, 'GetEntityData')?.score ?? -1 }))
      .filter((x) => x.score >= 0)
      .sort((a, b) => b.score - a.score)
      .map((x) => x.name)
    expect(ranked[0]).toBe('GetEntityData')
    expect(ranked.slice(0, 3)).toEqual([
      'GetEntityData',
      'GetEntityDataPath',
      'GetEntityDataByWpPath',
    ])
  })

  it('rewards word-start hits over mid-word matches of equal length', () => {
    // Both are 8 chars and match 'gd' as a subsequence; the separator-led hit in
    // the first should outrank the scattered hit in the second.
    const wordStarts = fuzzyScore('get_data', 'gd')?.score ?? -1
    const scattered = fuzzyScore('gxdyozza', 'gd')?.score ?? -1
    expect(wordStarts).toBeGreaterThan(scattered)
  })
})

describe('compareByScoreThenPath', () => {
  it('orders higher scores first', () => {
    expect(compareByScoreThenPath(500, 200, 'a.ts', 'b.ts')).toBeLessThan(0)
    expect(compareByScoreThenPath(200, 500, 'a.ts', 'b.ts')).toBeGreaterThan(0)
  })

  // The bug report: every `package.json` scores identically, so the tie-break
  // must surface the shallow top-level file above deeply nested ones instead of
  // degrading to a pure alphabetical order (which buried apps/editor/package.json).
  it('prefers the shorter path when scores are equal', () => {
    const paths = [
      'apps/editor/.runtime-resources/extensions/ai/package.json',
      'apps/editor/.runtime-resources/extensions/git/package.json',
      'apps/editor/package.json',
      'extensions-external/pdf/package.json',
    ]
    const ranked = [...paths].sort((a, b) => compareByScoreThenPath(2988, 2988, a, b))
    expect(ranked[0]).toBe('apps/editor/package.json')
  })

  it('falls back to a stable locale order for equal score and length', () => {
    expect(compareByScoreThenPath(100, 100, 'a/x.ts', 'b/x.ts')).toBeLessThan(0)
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
