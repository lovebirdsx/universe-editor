/*---------------------------------------------------------------------------------------------
 *  Tests for parseNesEdits — turning a Next Edit Suggestion model reply into a
 *  validated, sorted, non-overlapping set of whole-line replacements — and
 *  composeNesEdits — merging them into one contiguous span with unchanged lines
 *  kept verbatim. Covers fence stripping, embedded-JSON extraction, the multiple
 *  reply shapes (edits array / bare array / single object), the noEdit sentinel,
 *  type/shape validation, range bounds, overlap rejection and ordering.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { composeNesEdits, parseNesEdits } from '../nesEditParser.js'

describe('parseNesEdits', () => {
  it('parses an edits array', () => {
    const raw = '{"edits":[{"startLine":2,"endLine":3,"newText":"a\\nb"}]}'
    expect(parseNesEdits(raw, 10)).toEqual([{ startLine: 2, endLine: 3, newText: 'a\nb' }])
  })

  it('parses multiple edits and sorts them top-to-bottom', () => {
    const raw =
      '{"edits":[{"startLine":5,"endLine":5,"newText":"y"},{"startLine":2,"endLine":2,"newText":"x"}]}'
    expect(parseNesEdits(raw, 10)).toEqual([
      { startLine: 2, endLine: 2, newText: 'x' },
      { startLine: 5, endLine: 5, newText: 'y' },
    ])
  })

  it('accepts a bare top-level array', () => {
    const raw = '[{"startLine":1,"endLine":1,"newText":"x"}]'
    expect(parseNesEdits(raw, 5)).toEqual([{ startLine: 1, endLine: 1, newText: 'x' }])
  })

  it('tolerates a single edit object at the top level', () => {
    const raw = '{"startLine":1,"endLine":1,"newText":"x"}'
    expect(parseNesEdits(raw, 5)).toEqual([{ startLine: 1, endLine: 1, newText: 'x' }])
  })

  it('strips a fenced code block', () => {
    const raw = '```json\n{"edits":[{"startLine":1,"endLine":1,"newText":"x"}]}\n```'
    expect(parseNesEdits(raw, 5)).toEqual([{ startLine: 1, endLine: 1, newText: 'x' }])
  })

  it('extracts the first JSON value from surrounding prose', () => {
    const raw = 'Here is the edit:\n{"edits":[{"startLine":1,"endLine":1,"newText":"y"}]}\nThanks!'
    expect(parseNesEdits(raw, 5)).toEqual([{ startLine: 1, endLine: 1, newText: 'y' }])
  })

  it('keeps braces that live inside newText', () => {
    const raw = '{"edits":[{"startLine":1,"endLine":1,"newText":"function f() { return 1 }"}]}'
    expect(parseNesEdits(raw, 5)?.[0]?.newText).toBe('function f() { return 1 }')
  })

  it('returns null for the noEdit sentinel', () => {
    expect(parseNesEdits('{"noEdit":true}', 10)).toBeNull()
  })

  it('returns null for an empty edits array', () => {
    expect(parseNesEdits('{"edits":[]}', 10)).toBeNull()
  })

  it('returns null when any edit overlaps another', () => {
    const raw =
      '{"edits":[{"startLine":2,"endLine":4,"newText":"x"},{"startLine":4,"endLine":5,"newText":"y"}]}'
    expect(parseNesEdits(raw, 10)).toBeNull()
  })

  it('returns null when any edit is malformed', () => {
    const raw =
      '{"edits":[{"startLine":1,"endLine":1,"newText":"x"},{"startLine":2,"endLine":2,"newText":42}]}'
    expect(parseNesEdits(raw, 10)).toBeNull()
  })

  it('returns null when startLine > endLine', () => {
    expect(parseNesEdits('{"edits":[{"startLine":5,"endLine":3,"newText":"x"}]}', 10)).toBeNull()
  })

  it('returns null when endLine exceeds the document length', () => {
    expect(parseNesEdits('{"edits":[{"startLine":1,"endLine":99,"newText":"x"}]}', 10)).toBeNull()
  })

  it('returns null when startLine is below 1', () => {
    expect(parseNesEdits('{"edits":[{"startLine":0,"endLine":1,"newText":"x"}]}', 10)).toBeNull()
  })

  it('returns null for non-integer line numbers', () => {
    expect(parseNesEdits('{"edits":[{"startLine":1.5,"endLine":2,"newText":"x"}]}', 10)).toBeNull()
  })

  it('returns null for non-JSON replies', () => {
    expect(parseNesEdits('I cannot help with that', 10)).toBeNull()
  })

  it('returns null for malformed JSON', () => {
    expect(parseNesEdits('{"edits":[{"startLine":1, oops}]}', 10)).toBeNull()
  })
})

describe('composeNesEdits', () => {
  const doc = ['line1', 'line2', 'line3', 'line4', 'line5']
  const getLine = (n: number) => doc[n - 1] ?? ''

  it('returns a single edit unchanged in span', () => {
    const result = composeNesEdits([{ startLine: 2, endLine: 2, newText: 'X' }], getLine)
    expect(result).toEqual({ startLine: 2, endLine: 2, newText: 'X' })
  })

  it('merges two separated edits, keeping the gap line verbatim', () => {
    const result = composeNesEdits(
      [
        { startLine: 2, endLine: 2, newText: 'X' },
        { startLine: 4, endLine: 4, newText: 'Y' },
      ],
      getLine,
    )
    expect(result).toEqual({ startLine: 2, endLine: 4, newText: 'X\nline3\nY' })
  })

  it('merges two adjacent edits with no gap', () => {
    const result = composeNesEdits(
      [
        { startLine: 2, endLine: 2, newText: 'X' },
        { startLine: 3, endLine: 3, newText: 'Y' },
      ],
      getLine,
    )
    expect(result).toEqual({ startLine: 2, endLine: 3, newText: 'X\nY' })
  })

  it('preserves multi-line newText within a span', () => {
    const result = composeNesEdits(
      [
        { startLine: 1, endLine: 1, newText: 'A\nB' },
        { startLine: 3, endLine: 3, newText: 'C' },
      ],
      getLine,
    )
    expect(result).toEqual({ startLine: 1, endLine: 3, newText: 'A\nB\nline2\nC' })
  })
})
