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

  it('prefers the highest-severity bare word when the line has no bracketed marker', () => {
    expect(matchLogLevel('recovered from ERROR state, previously WARN')).toBe(LogLevel.Error)
  })

  it('lets the bracketed header marker win over level-looking payload words', () => {
    expect(matchLogLevel('[info] recovered from ERROR state')).toBe(LogLevel.Info)
    expect(matchLogLevel('[warn] payload mentions "[error]" text')).toBe(LogLevel.Warning)
  })

  it('classifies aggregated Acp Protocol lines by their [info] marker, not payload words', () => {
    const head =
      `[Acp Protocol] [21:10:42] [info] [renderer:3] [claude-code#a7626f] ← Notification ` +
      `'session/update' [session=61fd44af-b69a] params={"sessionId":"61fd44af","update":` +
      `{"content":{"type":"text","text":`
    expect(matchLogLevel(`${head}"WARN"}}}`)).toBe(LogLevel.Info)
    expect(matchLogLevel(`${head}"WW"}}}`)).toBe(LogLevel.Info)
    expect(matchLogLevel(`${head}"Warn"}}}`)).toBe(LogLevel.Info)
    expect(matchLogLevel(`${head}"Error"}}}`)).toBe(LogLevel.Info)
  })

  it('ignores bare level words past the header window of a tracer line', () => {
    const line =
      `[Trace - 21:10:42] [claude-code#a7626f] ← Notification 'session/update' ` +
      `[session=61fd44af-b69a] params={"sessionId":"61fd44af","update":{"content":` +
      `{"type":"text","text":"WARN"}}}`
    expect(matchLogLevel(line)).toBe(LogLevel.Trace)
  })

  it('still detects the tracer ERROR suffix on response lines', () => {
    const line = `[Trace - 21:10:42] [claude-code#a7626f] ← Response 'session/list' (1) in 847ms ERROR`
    expect(matchLogLevel(line)).toBe(LogLevel.Error)
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

  it('hides info entries whose payload merely contains WARN-like words', () => {
    const ls = [
      `[Acp Protocol] [21:10:42] [info] [renderer:3] [claude-code#a7626f] ← Notification ` +
        `'session/update' params={"update":{"content":{"text":"WARN"}}}`,
      '[warning] genuine warning',
    ]
    expect(computeHiddenRanges(ls, new Set([LogLevel.Info]), '')).toEqual([
      { startLine: 1, endLineExclusive: 2 },
    ])
  })
})
