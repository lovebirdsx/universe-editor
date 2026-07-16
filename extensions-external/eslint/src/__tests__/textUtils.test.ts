import { describe, expect, it } from 'vitest'
import { LineIndex } from '../textUtils.js'

describe('LineIndex', () => {
  it('maps offsets to 0-based line/character across newlines', () => {
    const text = 'abc\ndef\r\nghi'
    const idx = new LineIndex(text)
    expect(idx.positionAt(0)).toEqual({ line: 0, character: 0 })
    expect(idx.positionAt(2)).toEqual({ line: 0, character: 2 })
    // offset 4 is 'd' — start of line 1 (after '\n' at index 3).
    expect(idx.positionAt(4)).toEqual({ line: 1, character: 0 })
    // '\r\n' — the '\n' is at index 8, so 'g' at index 9 starts line 2.
    expect(idx.positionAt(9)).toEqual({ line: 2, character: 0 })
  })

  it('clamps out-of-range offsets to the text bounds', () => {
    const idx = new LineIndex('ab\ncd')
    expect(idx.positionAt(-5)).toEqual({ line: 0, character: 0 })
    expect(idx.positionAt(999)).toEqual({ line: 1, character: 2 })
  })

  it('fullRange spans the whole document', () => {
    const idx = new LineIndex('one\ntwo')
    expect(idx.fullRange()).toEqual({
      start: { line: 0, character: 0 },
      end: { line: 1, character: 3 },
    })
  })

  it('rangeAt maps a start/end offset pair', () => {
    const idx = new LineIndex('hello world')
    expect(idx.rangeAt(6, 11)).toEqual({
      start: { line: 0, character: 6 },
      end: { line: 0, character: 11 },
    })
  })
})
