/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/workbench/search/replace.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { applyReplacements } from '../replace.js'

describe('applyReplacements', () => {
  it('returns the input untouched when there are no edits', () => {
    expect(applyReplacements('hello', [])).toBe('hello')
  })

  it('replaces a single range on one line', () => {
    const out = applyReplacements('const foo = 1', [
      { line: 1, startColumn: 7, endColumn: 10, replaceText: 'bar' },
    ])
    expect(out).toBe('const bar = 1')
  })

  it('replaces multiple ranges on the same line in column-descending order', () => {
    // Two matches: cols 1..4 (foo) and cols 9..12 (foo)
    const out = applyReplacements('foo and foo', [
      { line: 1, startColumn: 1, endColumn: 4, replaceText: 'BAR' },
      { line: 1, startColumn: 9, endColumn: 12, replaceText: 'BAZ' },
    ])
    expect(out).toBe('BAR and BAZ')
  })

  it('replaces across multiple lines', () => {
    const text = 'foo\nbar\nfoo'
    const out = applyReplacements(text, [
      { line: 1, startColumn: 1, endColumn: 4, replaceText: 'X' },
      { line: 3, startColumn: 1, endColumn: 4, replaceText: 'Y' },
    ])
    expect(out).toBe('X\nbar\nY')
  })

  it('skips edits outside the line range', () => {
    const out = applyReplacements('a\nb', [
      { line: 9, startColumn: 1, endColumn: 2, replaceText: 'X' },
    ])
    expect(out).toBe('a\nb')
  })

  it('handles longer replacement text and shrinking replacement', () => {
    const grow = applyReplacements('foo', [
      { line: 1, startColumn: 1, endColumn: 4, replaceText: 'foobar' },
    ])
    expect(grow).toBe('foobar')
    const shrink = applyReplacements('foobar', [
      { line: 1, startColumn: 1, endColumn: 7, replaceText: 'x' },
    ])
    expect(shrink).toBe('x')
  })
})
