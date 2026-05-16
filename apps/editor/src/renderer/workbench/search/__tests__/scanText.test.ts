/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/workbench/search/scanText.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { compileQuery, isBinary, scanText } from '../scanText.js'

const baseQuery = {
  pattern: 'foo',
  isRegex: false,
  matchCase: false,
  matchWholeWord: false,
}

describe('scanText', () => {
  it('finds a single literal match on one line', () => {
    const re = compileQuery(baseQuery)
    const { matches, truncated } = scanText('hello foo bar', re, 100)
    expect(truncated).toBe(false)
    expect(matches).toHaveLength(1)
    expect(matches[0]?.lineNumber).toBe(1)
    expect(matches[0]?.ranges).toEqual([{ startColumn: 7, endColumn: 10 }])
  })

  it('uses the compiled regex when isRegex=true', () => {
    const re = compileQuery({ ...baseQuery, pattern: 'f\\w+', isRegex: true })
    const { matches } = scanText('foo bar', re, 100)
    expect(matches[0]?.ranges).toEqual([{ startColumn: 1, endColumn: 4 }])
  })

  it('respects matchCase=true', () => {
    const ciRe = compileQuery({ ...baseQuery, pattern: 'foo', matchCase: false })
    const csRe = compileQuery({ ...baseQuery, pattern: 'foo', matchCase: true })
    expect(scanText('FOO foo', ciRe, 100).matches[0]?.ranges).toHaveLength(2)
    expect(scanText('FOO foo', csRe, 100).matches[0]?.ranges).toHaveLength(1)
  })

  it('whole-word excludes partial matches', () => {
    const wholeRe = compileQuery({ ...baseQuery, matchWholeWord: true })
    expect(scanText('food', wholeRe, 100).matches).toHaveLength(0)
    expect(scanText('foo bar', wholeRe, 100).matches).toHaveLength(1)
  })

  it('stops at capPerFile and flags truncated', () => {
    const re = compileQuery(baseQuery)
    const text = 'foo foo foo\nfoo foo'
    const { matches, truncated } = scanText(text, re, 2)
    expect(truncated).toBe(true)
    const total = matches.reduce((n, m) => n + m.ranges.length, 0)
    expect(total).toBe(2)
  })

  it('isBinary detects a NUL byte in the first 8KB', () => {
    expect(isBinary('plain text')).toBe(false)
    expect(isBinary('abc\0def')).toBe(true)
  })
})
