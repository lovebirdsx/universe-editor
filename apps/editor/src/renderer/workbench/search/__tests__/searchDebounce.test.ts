/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/workbench/search/searchDebounce.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { regexDelayMultiplier, searchDebounceDelay } from '../searchDebounce.js'

describe('regexDelayMultiplier', () => {
  it('leaves a selective pattern at the base delay', () => {
    expect(regexDelayMultiplier('function')).toBe(1)
    expect(regexDelayMultiplier('foo|bar')).toBe(1)
    expect(regexDelayMultiplier('\\bexport\\b')).toBe(1)
    expect(regexDelayMultiplier('[a-z]')).toBe(1)
  })

  it('amplifies a catch-all character class', () => {
    // `\w` hits most alphanumerics in the sample — VSCode's middle bucket.
    expect(regexDelayMultiplier('\\w')).toBe(5)
  })

  it('gives the largest delay to patterns matching nearly everything', () => {
    // `.` matches every non-newline character; `a?` and `x*` match the empty
    // string at every position.
    expect(regexDelayMultiplier('.')).toBe(10)
    expect(regexDelayMultiplier('a?')).toBe(10)
    expect(regexDelayMultiplier('x*')).toBe(10)
    expect(regexDelayMultiplier('\\s*')).toBe(10)
  })

  it('falls back to the base delay for an invalid regex', () => {
    // Half-typed patterns are the common case while typing; the search itself
    // surfaces the syntax error.
    expect(regexDelayMultiplier('foo(')).toBe(1)
    expect(regexDelayMultiplier('[a-')).toBe(1)
  })
})

describe('searchDebounceDelay', () => {
  it('ignores the heuristic when the query is not a regex', () => {
    // A literal '.' is a plain character — no amplification.
    expect(searchDebounceDelay('.', false, 300)).toBe(300)
    expect(searchDebounceDelay('\\w', false, 300)).toBe(300)
  })

  it('scales the configured base for a regex query', () => {
    expect(searchDebounceDelay('function', true, 300)).toBe(300)
    expect(searchDebounceDelay('\\w', true, 300)).toBe(1500)
    expect(searchDebounceDelay('.', true, 300)).toBe(3000)
  })

  it('respects a customised base delay', () => {
    expect(searchDebounceDelay('function', true, 100)).toBe(100)
    expect(searchDebounceDelay('.', true, 100)).toBe(1000)
  })
})
