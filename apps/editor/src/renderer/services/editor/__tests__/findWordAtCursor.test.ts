/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/editor/findWordAtCursor.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import {
  collectMatches,
  computeNeedle,
  findWordHighlightController,
  pickTarget,
  type FindWordMatch,
  type FindWordNeedle,
} from '../findWordAtCursor.js'

/** Minimal ITextModel stand-in: `\w+` words, indexOf-based findMatches. */
class FakeTextModel {
  private readonly _lines: string[]
  constructor(text: string) {
    this._lines = text.split('\n')
  }
  getOffsetAt(position: { lineNumber: number; column: number }): number {
    let offset = 0
    for (let i = 0; i < position.lineNumber - 1; i++) offset += this._lines[i]!.length + 1
    return offset + position.column - 1
  }
  getPositionAt(offset: number): { lineNumber: number; column: number } {
    let rest = offset
    for (let i = 0; i < this._lines.length; i++) {
      const len = this._lines[i]!.length
      if (rest <= len) return { lineNumber: i + 1, column: rest + 1 }
      rest -= len + 1
    }
    const last = this._lines.length
    return { lineNumber: last, column: this._lines[last - 1]!.length + 1 }
  }
  getWordAtPosition(position: { lineNumber: number; column: number }) {
    const line = this._lines[position.lineNumber - 1] ?? ''
    const re = /\w+/g
    let m: RegExpExecArray | null
    while ((m = re.exec(line))) {
      const startColumn = m.index + 1
      const endColumn = startColumn + m[0].length
      if (position.column >= startColumn && position.column <= endColumn) {
        return { word: m[0], startColumn, endColumn }
      }
    }
    return null
  }
  getValueInRange(range: {
    startLineNumber: number
    startColumn: number
    endLineNumber: number
    endColumn: number
  }): string {
    if (range.startLineNumber === range.endLineNumber) {
      return this._lines[range.startLineNumber - 1]!.slice(
        range.startColumn - 1,
        range.endColumn - 1,
      )
    }
    const parts = [this._lines[range.startLineNumber - 1]!.slice(range.startColumn - 1)]
    for (let i = range.startLineNumber; i < range.endLineNumber - 1; i++)
      parts.push(this._lines[i]!)
    parts.push(this._lines[range.endLineNumber - 1]!.slice(0, range.endColumn - 1))
    return parts.join('\n')
  }
  findMatches(
    searchString: string,
    _scope: unknown,
    _isRegex: boolean,
    matchCase: boolean,
    _wordSeparators: unknown,
    _captureMatches: boolean,
    _limit: number,
  ) {
    const text = this._lines.join('\n')
    const haystack = matchCase ? text : text.toLowerCase()
    const needle = matchCase ? searchString : searchString.toLowerCase()
    const results: Array<{ range: FakeRange }> = []
    let index = haystack.indexOf(needle)
    while (index !== -1) {
      const start = this.getPositionAt(index)
      const end = this.getPositionAt(index + searchString.length)
      results.push({
        range: new FakeRange(start.lineNumber, start.column, end.lineNumber, end.column),
      })
      index = haystack.indexOf(needle, index + 1)
    }
    return results
  }
}

class FakeRange {
  constructor(
    readonly startLineNumber: number,
    readonly startColumn: number,
    readonly endLineNumber: number,
    readonly endColumn: number,
  ) {}
  getStartPosition() {
    return { lineNumber: this.startLineNumber, column: this.startColumn }
  }
}

function selection(startLine: number, startColumn: number, endLine: number, endColumn: number) {
  return {
    startLineNumber: startLine,
    startColumn,
    endLineNumber: endLine,
    endColumn,
    isEmpty: () => startLine === endLine && startColumn === endColumn,
    getPosition: () => ({ lineNumber: endLine, column: endColumn }),
    getStartPosition: () => ({ lineNumber: startLine, column: startColumn }),
  } as never
}

function cursor(line: number, column: number) {
  return selection(line, column, line, column)
}

describe('computeNeedle', () => {
  it('collapsed cursor inside a word → strict needle with cursor delta', () => {
    const model = new FakeTextModel('alpha beta gamma')
    // "beta" spans columns 7..11; cursor at column 9 → delta 2
    const needle = computeNeedle(model as never, cursor(1, 9))
    expect(needle).toEqual({
      mode: 'strict',
      text: 'beta',
      matchCase: true,
      referenceOffset: 6,
      cursorDelta: 2,
    })
  })

  it('cursor on whitespace → undefined', () => {
    // col 4 sits strictly between "ab" (ends col 3) and "cd" (starts col 5).
    const model = new FakeTextModel('ab  cd')
    expect(computeNeedle(model as never, cursor(1, 4))).toBeUndefined()
  })

  it('single-line selection → loose needle, case insensitive', () => {
    const model = new FakeTextModel('hello World hello')
    const needle = computeNeedle(model as never, selection(1, 7, 1, 12))
    expect(needle).toEqual({
      mode: 'loose',
      text: 'World',
      matchCase: false,
      referenceOffset: 6,
      cursorDelta: 0,
    })
  })

  it('multi-line selection → undefined', () => {
    const model = new FakeTextModel('ab\ncd')
    expect(computeNeedle(model as never, selection(1, 1, 2, 2))).toBeUndefined()
  })
})

describe('collectMatches', () => {
  const strictFoo: FindWordNeedle = {
    mode: 'strict',
    text: 'foo',
    matchCase: true,
    referenceOffset: 0,
    cursorDelta: 0,
  }
  const looseFoo: FindWordNeedle = { ...strictFoo, mode: 'loose', matchCase: false }

  it('strict keeps whole-word hits only, case sensitive', () => {
    const model = new FakeTextModel('foo foobar Foo foo')
    const matches = collectMatches(model as never, strictFoo)
    expect(matches.map((m) => m.startOffset)).toEqual([0, 15])
  })

  it('loose matches substrings, case insensitive', () => {
    const model = new FakeTextModel('foo foobar Foo foo')
    const matches = collectMatches(model as never, looseFoo)
    expect(matches.map((m) => m.startOffset)).toEqual([0, 4, 11, 15])
  })
})

function matchAt(startOffset: number): FindWordMatch {
  return {
    range: {
      startLineNumber: 1,
      startColumn: startOffset + 1,
      endLineNumber: 1,
      endColumn: startOffset + 4,
    },
    startOffset,
  }
}

function needleAt(referenceOffset: number): FindWordNeedle {
  return { mode: 'strict', text: 'foo', matchCase: true, referenceOffset, cursorDelta: 0 }
}

describe('pickTarget', () => {
  const matches = [matchAt(0), matchAt(10), matchAt(20)]

  it('next jumps to the following match, wrapping at the end', () => {
    expect(pickTarget(matches, needleAt(0), 1)?.startOffset).toBe(10)
    expect(pickTarget(matches, needleAt(10), 1)?.startOffset).toBe(20)
    expect(pickTarget(matches, needleAt(20), 1)?.startOffset).toBe(0)
  })

  it('previous jumps to the preceding match, wrapping at the start', () => {
    expect(pickTarget(matches, needleAt(10), -1)?.startOffset).toBe(0)
    expect(pickTarget(matches, needleAt(0), -1)?.startOffset).toBe(20)
  })

  it('previous from inside the word must not land on the word itself', () => {
    // Anchor is the word start (10), not the cursor offset (13) — otherwise
    // previous would pick the match at 10, i.e. the word under the cursor.
    expect(pickTarget(matches, needleAt(10), -1)?.startOffset).toBe(0)
  })

  it('sole occurrence → undefined in both directions', () => {
    const sole = [matchAt(5)]
    expect(pickTarget(sole, needleAt(5), 1)).toBeUndefined()
    expect(pickTarget(sole, needleAt(5), -1)).toBeUndefined()
  })

  it('no matches → undefined', () => {
    expect(pickTarget([], needleAt(0), 1)).toBeUndefined()
  })
})

describe('findWordHighlightController', () => {
  function fakeEditor() {
    const listeners = new Set<() => void>()
    const collection = { set: vi.fn(), clear: vi.fn() }
    const editor = {
      createDecorationsCollection: () => collection,
      onDidChangeCursorSelection: (cb: () => void) => {
        listeners.add(cb)
        return { dispose: () => listeners.delete(cb) }
      },
      fireSelectionChange: () => {
        for (const l of [...listeners]) l()
      },
    }
    return { editor: editor as never, collection, fire: editor.fireSelectionChange }
  }

  it('show paints the decoration; a later selection change clears it', () => {
    const { editor, collection, fire } = fakeEditor()
    const range = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 4 }
    findWordHighlightController.show(editor, range)
    findWordHighlightController.armClearOnSelectionChange(editor)
    expect(collection.set).toHaveBeenCalledWith([
      { range, options: { className: 'findWordAtCursorMatch' } },
    ])
    fire()
    expect(collection.clear).toHaveBeenCalled()
  })

  it('a selection change fired before arming does NOT clear (ordering contract)', () => {
    const { editor, collection, fire } = fakeEditor()
    // Mirrors the action: setSelection fires the event first, then we show+arm.
    fire()
    findWordHighlightController.show(editor, {
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 4,
    })
    collection.clear.mockClear() // show() always clears first; discount that call
    findWordHighlightController.armClearOnSelectionChange(editor)
    expect(collection.clear).not.toHaveBeenCalled()
  })

  it('clear disposes a pending listener and wipes decorations', () => {
    const { editor, collection, fire } = fakeEditor()
    findWordHighlightController.show(editor, {
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 4,
    })
    findWordHighlightController.armClearOnSelectionChange(editor)
    findWordHighlightController.clear(editor)
    collection.clear.mockClear()
    fire() // listener was disposed — no more clearing
    expect(collection.clear).not.toHaveBeenCalled()
  })
})
