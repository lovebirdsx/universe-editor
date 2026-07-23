import { describe, expect, it } from 'vitest'
import { monacoChangesToContentChanges } from '../documentSyncChanges.js'

describe('monacoChangesToContentChanges', () => {
  it('converts 1-based Monaco ranges to 0-based LSP ranges', () => {
    const [c] = monacoChangesToContentChanges([
      {
        range: { startLineNumber: 3, startColumn: 5, endLineNumber: 3, endColumn: 7 },
        rangeOffset: 20,
        text: 'x',
      },
    ])
    expect(c).toEqual({
      range: { start: { line: 2, character: 4 }, end: { line: 2, character: 6 } },
      text: 'x',
    })
  })

  it('orders same-base changes end-of-document-first so sequential application is safe', () => {
    // Two simultaneous edits (multi-cursor): offsets 5 and 30. Sequential (LSP)
    // application must see the later-in-document one first, otherwise the first
    // insert shifts the second range.
    const changes = monacoChangesToContentChanges([
      {
        range: { startLineNumber: 1, startColumn: 6, endLineNumber: 1, endColumn: 6 },
        rangeOffset: 5,
        text: 'a',
      },
      {
        range: { startLineNumber: 2, startColumn: 10, endLineNumber: 2, endColumn: 10 },
        rangeOffset: 30,
        text: 'b',
      },
    ])
    expect(changes.map((c) => c.text)).toEqual(['b', 'a'])
  })

  it('keeps an already-descending batch as-is', () => {
    const changes = monacoChangesToContentChanges([
      {
        range: { startLineNumber: 5, startColumn: 1, endLineNumber: 5, endColumn: 2 },
        rangeOffset: 50,
        text: 'B',
      },
      {
        range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 },
        rangeOffset: 0,
        text: 'A',
      },
    ])
    expect(changes.map((c) => c.text)).toEqual(['B', 'A'])
  })
})
