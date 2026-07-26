import { describe, expect, it } from 'vitest'
import { LogLevel } from '@universe-editor/platform'
import {
  buildLogEntries,
  computeHiddenRanges,
  matchLogLevel,
  parseLogFilterText,
} from '../logEntryIndex.js'

describe('matchLogLevel', () => {
  it('matches bracketed tags', () => {
    expect(matchLogLevel('[error] boom')).toBe(LogLevel.Error)
    expect(matchLogLevel('[warning] careful')).toBe(LogLevel.Warning)
    expect(matchLogLevel('[INFO] hello')).toBe(LogLevel.Info)
    expect(matchLogLevel('[debug] detail')).toBe(LogLevel.Debug)
    expect(matchLogLevel('[trace] noisy')).toBe(LogLevel.Trace)
  })

  it('matches bare-word levels', () => {
    expect(matchLogLevel('2026-05-21 ERROR something failed')).toBe(LogLevel.Error)
    expect(matchLogLevel('WARN: low disk')).toBe(LogLevel.Warning)
    expect(matchLogLevel('INFO started')).toBe(LogLevel.Info)
    expect(matchLogLevel('Debug: value = 1')).toBe(LogLevel.Debug)
    expect(matchLogLevel('TRACE enter fn')).toBe(LogLevel.Trace)
  })

  it('prefers error when several words appear', () => {
    expect(matchLogLevel('[info] recovered from ERROR state')).toBe(LogLevel.Error)
  })

  it('returns undefined for plain prose', () => {
    expect(matchLogLevel('at foo (bar.ts:12:3)')).toBeUndefined()
    expect(matchLogLevel('{ "a": 1 }')).toBeUndefined()
    expect(matchLogLevel('')).toBeUndefined()
  })
})

describe('buildLogEntries', () => {
  it('groups continuation lines under the preceding header', () => {
    const lines = [
      '[info] start',
      '  at foo (a.ts:1:1)',
      '  at bar (b.ts:2:2)',
      '[error] boom',
      '  stack line',
      '[info] done',
    ]
    expect(buildLogEntries(lines)).toEqual([
      { startLine: 1, endLineExclusive: 4, level: LogLevel.Info },
      { startLine: 4, endLineExclusive: 6, level: LogLevel.Error },
      { startLine: 6, endLineExclusive: 7, level: LogLevel.Info },
    ])
  })

  it('treats lines before the first header as a level-less entry', () => {
    const lines = ['preamble one', 'preamble two', '[warn] watch out']
    expect(buildLogEntries(lines)).toEqual([
      { startLine: 1, endLineExclusive: 3, level: undefined },
      { startLine: 3, endLineExclusive: 4, level: LogLevel.Warning },
    ])
  })

  it('handles an empty buffer', () => {
    expect(buildLogEntries([])).toEqual([])
  })
})

describe('parseLogFilterText', () => {
  it('splits on commas and trims', () => {
    expect(parseLogFilterText('foo, bar')).toEqual({ includes: ['foo', 'bar'], excludes: [] })
  })

  it('honours the ! exclusion prefix', () => {
    expect(parseLogFilterText('foo, !bar')).toEqual({ includes: ['foo'], excludes: ['bar'] })
  })

  it('keeps commas inside quoted terms', () => {
    expect(parseLogFilterText('foo, "a,b"')).toEqual({ includes: ['foo', 'a,b'], excludes: [] })
  })

  it('lowercases terms and ignores empty segments', () => {
    expect(parseLogFilterText('Foo, , !BAR')).toEqual({ includes: ['foo'], excludes: ['bar'] })
  })
})

describe('computeHiddenRanges', () => {
  const lines = [
    '[trace] t1',
    '[debug] d1',
    '[info] i1 keepme',
    '  continuation',
    '[warning] w1',
    '[error] e1',
  ]

  it('returns nothing when no filter is active', () => {
    expect(computeHiddenRanges(lines, new Set(), '')).toEqual([])
  })

  it('hides entries whose level is off, merging adjacent ones', () => {
    const hidden = computeHiddenRanges(lines, new Set([LogLevel.Trace, LogLevel.Debug]), '')
    expect(hidden).toEqual([{ startLine: 1, endLineExclusive: 3 }])
  })

  it('keeps entries whose continuation line matches the text filter', () => {
    const hidden = computeHiddenRanges(lines, new Set(), 'continuation')
    expect(hidden).toEqual([
      { startLine: 1, endLineExclusive: 3 },
      { startLine: 5, endLineExclusive: 7 },
    ])
  })

  it('excludes terms remove entries even when an include matches', () => {
    const hidden = computeHiddenRanges(lines, new Set(), 'e1, !e1')
    expect(hidden).toEqual([{ startLine: 1, endLineExclusive: 7 }])
  })

  it('combines level and text filters', () => {
    const hidden = computeHiddenRanges(lines, new Set([LogLevel.Warning]), 'keepme')
    expect(hidden).toEqual([
      { startLine: 1, endLineExclusive: 3 },
      { startLine: 5, endLineExclusive: 7 },
    ])
  })

  it('never hides the level-less preamble on level filters', () => {
    const withPreamble = ['hello world', '[error] e1']
    expect(computeHiddenRanges(withPreamble, new Set([LogLevel.Error]), '')).toEqual([
      { startLine: 2, endLineExclusive: 3 },
    ])
  })
})
