import { describe, expect, it } from 'vitest'
import { mapStringIndexToCell, readWrappedWindow } from '../terminalBufferText.js'
import { makeBufferFromLines, makeTerminalBuffer } from './terminalFakeBuffer.js'

describe('readWrappedWindow', () => {
  it('stops upward expansion at a non-wrapped line', () => {
    const buf = makeBufferFromLines(
      [
        { text: 'zero', isWrapped: false },
        { text: 'one', isWrapped: false },
        { text: 'two', isWrapped: true },
      ],
      10,
    )
    const win = readWrappedWindow(buf, 2)
    expect(win.startLineIndex).toBe(1)
    expect(win.text).toBe('onetwo')
  })

  it('stops downward expansion at a non-wrapped line', () => {
    const buf = makeBufferFromLines(
      [
        { text: 'top', isWrapped: false },
        { text: 'mid', isWrapped: true },
        { text: 'bot', isWrapped: false },
      ],
      10,
    )
    const win = readWrappedWindow(buf, 1)
    expect(win.startLineIndex).toBe(0)
    expect(win.text).toBe('topmid')
  })

  it('stops expansion at lines containing a space', () => {
    const buf = makeBufferFromLines(
      [
        { text: 'aa bb', isWrapped: true },
        { text: 'cccc', isWrapped: true },
        { text: 'dd ee', isWrapped: true },
      ],
      10,
    )
    const win = readWrappedWindow(buf, 1)
    expect(win.startLineIndex).toBe(0)
    expect(win.text).toBe('aa bbccccdd ee')
  })

  it('does not expand upward when the current line starts with a space', () => {
    const buf = makeBufferFromLines(
      [
        { text: 'prev', isWrapped: true },
        { text: ' cur', isWrapped: true },
      ],
      10,
    )
    const win = readWrappedWindow(buf, 1)
    expect(win.startLineIndex).toBe(1)
    expect(win.text).toBe(' cur')
  })

  it('applies the 2048 cap independently in each direction', () => {
    const buf = makeTerminalBuffer('a'.repeat(5000), 100)
    const win = readWrappedWindow(buf, 24)
    // 21 lines up (2100 >= 2048 stops) + current + 21 lines down.
    expect(win.text).toHaveLength(4300)
    expect(win.startLineIndex).toBe(3)
  })

  // startLineIndex is the anchor mapStringIndexToCell walks from, so naming a
  // line that isn't in `text` would shift every mapped coordinate by one line.
  it('reports a startLineIndex whose line is the first one joined into text', () => {
    const cols = 100
    // Distinct per-line content (no spaces, exactly `cols` wide) so the prefix
    // assertion below can actually tell the lines apart.
    const buf = makeBufferFromLines(
      Array.from({ length: 60 }, (_, i) => ({
        text: `L${i}`.padEnd(cols, 'x'),
        isWrapped: true,
      })),
      cols,
    )
    const win = readWrappedWindow(buf, 24)

    const firstLine = buf.getLine(win.startLineIndex)
    expect(firstLine).toBeDefined()
    expect(win.text.startsWith(firstLine!.translateToString(true))).toBe(true)
    expect(win.text.startsWith('L3x')).toBe(true)
  })
})

describe('mapStringIndexToCell', () => {
  it('returns null when the line is missing', () => {
    const buf = makeTerminalBuffer('abc', 10)
    expect(mapStringIndexToCell(buf, 5, 0, 1)).toBeNull()
  })

  it('maps CJK wide chars to cell columns, not string indices', () => {
    const buf = makeTerminalBuffer('/项目/a.ts', 20)
    expect(mapStringIndexToCell(buf, 0, 0, 0)).toEqual({ y: 0, x: 0 })
    expect(mapStringIndexToCell(buf, 0, 0, 8)).toEqual({ y: 0, x: 10 })
  })

  it('corrects for an early-wrapped wide char at a line end', () => {
    const buf = makeTerminalBuffer('/ab中.ts', 4)
    expect(mapStringIndexToCell(buf, 0, 0, 3)).toEqual({ y: 1, x: 0 })
    expect(mapStringIndexToCell(buf, 0, 0, 7)).toEqual({ y: 2, x: 1 })
  })

  // A combining mark lives in the *preceding* cell, so one cell yields 2 JS
  // chars — the `chars.length || 1` decrement is the only thing keeping the
  // string index and the column in step here (no wide char involved).
  it('maps a combining mark as two string chars inside one cell', () => {
    // Decomposed '\u00e9' (e + U+0301) — xterm keeps both in cell 4, so 11 string
    // chars span only 10 cells with no wide char involved.
    const text = '/cafe\u0301/a.ts'
    const buf = makeTerminalBuffer(text, 20)
    const line = buf.getLine(0)
    expect(text).toHaveLength(11)
    expect(line!.translateToString(true)).toBe(text)
    expect(line!.getCell(4)!.getChars()).toBe('e\u0301')
    // Cells: / c a f e+U+0301 / a . t s — the 6th string char sits in cell 5.
    expect(mapStringIndexToCell(buf, 0, 0, 6)).toEqual({ y: 0, x: 5 })
    // All 11 chars fill cells 0..9, so the end lands on the first padding cell.
    expect(mapStringIndexToCell(buf, 0, 0, 11)).toEqual({ y: 0, x: 10 })
  })
})
