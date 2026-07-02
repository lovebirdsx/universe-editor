import { describe, expect, it } from 'vitest'
import { applyTextEditsToString, stripSnippet } from '../fileBulkEditService.js'

const range = (sl: number, sc: number, el: number, ec: number) => ({
  startLineNumber: sl,
  startColumn: sc,
  endLineNumber: el,
  endColumn: ec,
})

describe('applyTextEditsToString', () => {
  it('replaces a single-line span', () => {
    expect(
      applyTextEditsToString('const foo = 1', [{ range: range(1, 7, 1, 10), text: 'bar' }]),
    ).toBe('const bar = 1')
  })

  it('applies multiple edits without offset drift (sorted bottom-up)', () => {
    const text = 'foo + foo'
    const edits = [
      { range: range(1, 1, 1, 4), text: 'bar' },
      { range: range(1, 7, 1, 10), text: 'bar' },
    ]
    expect(applyTextEditsToString(text, edits)).toBe('bar + bar')
  })

  it('handles edits across multiple lines', () => {
    const text = 'let foo = 1\nconst y = foo + foo'
    const edits = [
      { range: range(1, 5, 1, 8), text: 'bar' },
      { range: range(2, 11, 2, 14), text: 'bar' },
      { range: range(2, 17, 2, 20), text: 'bar' },
    ]
    expect(applyTextEditsToString(text, edits)).toBe('let bar = 1\nconst y = bar + bar')
  })

  it('supports insertions (empty range)', () => {
    expect(applyTextEditsToString('ab', [{ range: range(1, 2, 1, 2), text: 'X' }])).toBe('aXb')
  })

  it('returns the original text when there are no edits', () => {
    expect(applyTextEditsToString('unchanged', [])).toBe('unchanged')
  })
})

describe('stripSnippet', () => {
  it('keeps the default text of a placeholder', () => {
    expect(stripSnippet('![${1:alt text}](assets/x.png)')).toBe('![alt text](assets/x.png)')
    expect(stripSnippet('[${1:text}](a.md)')).toBe('[text](a.md)')
  })

  it('drops empty tab stops ($0, ${2}, $1)', () => {
    expect(stripSnippet('[${1:text}](a.md)$0')).toBe('[text](a.md)')
    expect(stripSnippet('a${2}b$1c')).toBe('abc')
  })

  it('unescapes \\$ \\} \\\\ to their literal characters', () => {
    expect(stripSnippet('price \\$5')).toBe('price $5')
    expect(stripSnippet('a\\}b')).toBe('a}b')
    expect(stripSnippet('a\\\\b')).toBe('a\\b')
  })

  it('leaves plain text untouched', () => {
    expect(stripSnippet('just [text](a.md) here')).toBe('just [text](a.md) here')
  })
})
