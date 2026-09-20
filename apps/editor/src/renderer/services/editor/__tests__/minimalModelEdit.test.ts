/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for minimalModelEdit — reconciling a model to new content with a single
 *  minimal edit (preserving folding outside the change) instead of setValue.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  applyMinimalTextEdit,
  computeMinimalTextEdit,
  detachView,
  normalizeToModelEol,
  type IEditableTextModel,
} from '../minimalModelEdit.js'

interface RecordedEdit {
  range: {
    startLineNumber: number
    startColumn: number
    endLineNumber: number
    endColumn: number
  }
  text: string
}

/** Monaco 的 `PieceTreeTextBufferFactory._getEOL`：CRLF（含裸 CR）过半即 CRLF，否则 LF。 */
function modelEol(text: string): '\r\n' | '\n' {
  const crlf = text.match(/\r\n/g)?.length ?? 0
  const lf = text.match(/(?<!\r)\n/g)?.length ?? 0
  const cr = text.match(/\r(?!\n)/g)?.length ?? 0
  const total = cr + lf + crlf
  if (total === 0) return '\n'
  return cr + crlf > total / 2 ? '\r\n' : '\n'
}

/**
 * Minimal in-memory stand-in for an editable Monaco model: tracks its value and
 * records whether a reconcile went through pushEditOperations (a real edit) or
 * setValue (a flush). Offset→position uses the same line/column math as Monaco.
 *
 * 与 piece tree 一样整份缓冲区只有一种行尾（由初始文本按 `modelEol` 决定）并通过 `getEOL()`
 * 报告——下面的行尾用例依赖的正是这条：盘上可以混写，模型永远不会。
 */
class FakeModel implements IEditableTextModel {
  setValueCalls = 0
  edits: RecordedEdit[] = []
  private readonly _eol: '\r\n' | '\n'
  constructor(private _value: string) {
    this._eol = modelEol(_value)
    this._value = _value.replace(/\r\n|\r|\n/g, this._eol)
  }

  getValue(): string {
    return this._value
  }

  getEOL(): string {
    return this._eol
  }

  setValue(value: string): void {
    this.setValueCalls++
    this._value = value.replace(/\r\n|\r|\n/g, this._eol)
  }

  getPositionAt(offset: number): { lineNumber: number; column: number } {
    const clamped = Math.max(0, Math.min(offset, this._value.length))
    let line = 1
    let lastNewline = -1
    for (let i = 0; i < clamped; i++) {
      if (this._value.charCodeAt(i) === 10 /* \n */) {
        line++
        lastNewline = i
      }
    }
    return { lineNumber: line, column: clamped - lastNewline }
  }

  pushEditOperations(
    _base: null,
    edits: ReadonlyArray<{
      range: {
        startLineNumber: number
        startColumn: number
        endLineNumber: number
        endColumn: number
      }
      text: string
    }>,
  ): null {
    for (const e of edits) {
      this.edits.push({ range: { ...e.range }, text: e.text })
      // Apply by reconstructing offsets so getValue() stays correct. Inserted
      // text is EOL-normalised the way Monaco's piece tree normalises it.
      const start = this._offsetOf(e.range.startLineNumber, e.range.startColumn)
      const end = this._offsetOf(e.range.endLineNumber, e.range.endColumn)
      const text = e.text.replace(/\r\n|\r|\n/g, this._eol)
      this._value = this._value.slice(0, start) + text + this._value.slice(end)
    }
    return null
  }

  private _offsetOf(line: number, column: number): number {
    let offset = 0
    let curLine = 1
    while (curLine < line) {
      const nl = this._value.indexOf('\n', offset)
      if (nl === -1) break
      offset = nl + 1
      curLine++
    }
    return offset + (column - 1)
  }
}

describe('computeMinimalTextEdit', () => {
  it('returns null for identical text', () => {
    expect(computeMinimalTextEdit('abc\ndef\n', 'abc\ndef\n')).toBeNull()
  })

  it('isolates a single changed line, trimming shared prefix and suffix', () => {
    const oldText = 'line1\nline2\nline3\n'
    const newText = 'line1\nCHANGED\nline3\n'
    const edit = computeMinimalTextEdit(oldText, newText)!
    expect(edit).not.toBeNull()
    // Only "line2" is replaced — prefix ("line1\n") and suffix ("\nline3\n") shared.
    expect(edit.start).toBe('line1\n'.length)
    expect(edit.end).toBe('line1\nline2'.length)
    expect(edit.text).toBe('CHANGED')
    // Reconstruction invariant.
    expect(oldText.slice(0, edit.start) + edit.text + oldText.slice(edit.end)).toBe(newText)
  })

  it('handles pure insertion and pure deletion', () => {
    const ins = computeMinimalTextEdit('ac', 'abc')!
    expect(ins).toMatchObject({ start: 1, end: 1, text: 'b' })
    const del = computeMinimalTextEdit('abc', 'ac')!
    expect(del).toMatchObject({ start: 1, end: 2, text: '' })
  })

  it('returns a span that survives being copied out of a multi-megabyte text', () => {
    const filler = `line\r\n`.repeat(600_000)
    const appended = `2026-09-19T00:00:00.000Z INFO tick=${'x'.repeat(4_000)}\r\n`
    const edit = computeMinimalTextEdit(filler, filler + appended)!
    // The span is the appended text, character for character — the copy out of the
    // 7MB parent must not drop, double or reorder anything at its chunk seams.
    expect(edit).toEqual({ start: filler.length, end: filler.length, text: appended })
  })
})

describe('detachView', () => {
  /** The copy runs one `split('')`/`join('')` per chunk; keep the boundary here in
   *  sync with `COPY_CHUNK_CHARS` so the straddling cases below really straddle. */
  const CHUNK = 8192

  it('passes short and empty text through unchanged', () => {
    expect(detachView('')).toBe('')
    expect(detachView('abc')).toBe('abc')
    expect(detachView('\r\n')).toBe('\r\n')
  })

  it('round-trips text that spans several chunks, exactly', () => {
    const text = Array.from({ length: 5 * CHUNK }, (_, i) =>
      String.fromCharCode(32 + (i % 90)),
    ).join('')
    expect(detachView(text)).toBe(text)
    expect(detachView(text).length).toBe(text.length)
  })

  it('keeps a surrogate pair that straddles a chunk boundary intact', () => {
    // The emoji's two code units land in different chunks; rejoining them in order
    // has to reproduce the pair, not two replacement characters.
    const text = `${'a'.repeat(CHUNK - 1)}😀${'b'.repeat(CHUNK)}`
    const copy = detachView(text)
    expect(copy).toBe(text)
    expect(copy.codePointAt(CHUNK - 1)).toBe(0x1f600)
    expect([...copy].length).toBe([...text].length)
  })

  it('keeps lone surrogates as themselves', () => {
    // A `TextEncoder`/`Buffer` round-trip would turn both of these into U+FFFD.
    const text = `${'a'.repeat(CHUNK - 1)}\uD800${'b'.repeat(CHUNK)}\uDFFF${'c'.repeat(8)}`
    const copy = detachView(text)
    expect(copy).toBe(text)
    expect(copy.charCodeAt(CHUNK - 1)).toBe(0xd800)
    expect(copy.charCodeAt(2 * CHUNK)).toBe(0xdfff)
  })

  it('preserves mixed line endings and a leading BOM byte for byte', () => {
    const text = `﻿a\r\nb\rc\nd${'e'.repeat(CHUNK)}`
    const copy = detachView(text)
    expect(copy).toBe(text)
    expect(copy.charCodeAt(0)).toBe(0xfeff)
  })
})

describe('applyMinimalTextEdit', () => {
  it('reconciles via a single edit that touches only the changed span', () => {
    const model = new FakeModel('line1\nline2\nline3\n')
    const result = applyMinimalTextEdit(model, 'line1\nCHANGED\nline3\n')
    expect(result).toBe('edited')
    expect(model.setValueCalls).toBe(0)
    expect(model.edits).toHaveLength(1)
    // The edit is confined to line 2 — lines 1 and 3 (and their folding) untouched.
    expect(model.edits[0]!.range.startLineNumber).toBe(2)
    expect(model.edits[0]!.range.endLineNumber).toBe(2)
    expect(model.getValue()).toBe('line1\nCHANGED\nline3\n')
  })

  it('is a no-op when content already matches', () => {
    const model = new FakeModel('same\n')
    expect(applyMinimalTextEdit(model, 'same\n')).toBe('noop')
    expect(model.setValueCalls).toBe(0)
    expect(model.edits).toHaveLength(0)
  })

  it('round-trips an arbitrary multi-line rewrite to the exact new content', () => {
    const model = new FakeModel('{\n  "a": 1,\n  "b": 2,\n  "c": 3\n}\n')
    const next = '{\n  "a": 1,\n  "b": 99,\n  "c": 3,\n  "d": 4\n}\n'
    expect(applyMinimalTextEdit(model, next)).toBe('edited')
    expect(model.getValue()).toBe(next)
    expect(model.setValueCalls).toBe(0)
  })

  it('falls back to setValue when the model lacks edit APIs', () => {
    let value = 'old\n'
    let setCalls = 0
    const bare: IEditableTextModel = {
      getValue: () => value,
      setValue: (v: string) => {
        setCalls++
        value = v
      },
    }
    expect(applyMinimalTextEdit(bare, 'new\n')).toBe('replaced')
    expect(setCalls).toBe(1)
    expect(value).toBe('new\n')
  })
})

describe('normalizeToModelEol', () => {
  it('returns the same string when every ending already matches', () => {
    const model = new FakeModel('a\r\nb\r\n')
    const text = 'one\r\ntwo\r\n'
    // Identity, not just equality: a multi-megabyte text must not be copied to
    // learn that it needs no rewriting.
    expect(normalizeToModelEol(text, model)).toBe(text)
  })

  it('rewrites bare LF and lone CR to the model CRLF', () => {
    const model = new FakeModel('a\r\nb\r\n')
    expect(normalizeToModelEol('one\ntwo\rthree\r\n', model)).toBe('one\r\ntwo\r\nthree\r\n')
  })

  it('rewrites CRLF down to a model LF', () => {
    const model = new FakeModel('a\nb\n')
    expect(normalizeToModelEol('one\r\ntwo\rthree\n', model)).toBe('one\ntwo\nthree\n')
  })

  it('keeps the text untouched when the model cannot report its EOL', () => {
    const noEol: IEditableTextModel = { getValue: () => '', setValue: () => {} }
    const text = 'one\ntwo\n'
    expect(normalizeToModelEol(text, noEol)).toBe(text)
    expect(normalizeToModelEol(text, undefined)).toBe(text)
  })

  it('never touches a leading BOM', () => {
    const model = new FakeModel('a\r\nb\r\n')
    expect(normalizeToModelEol('﻿one\ntwo\n', model)).toBe('﻿one\r\ntwo\r\n')
  })
})

describe('applyMinimalTextEdit across differing line endings', () => {
  // 回归（OOM 的「写入侧」）：盘上行尾混写，而模型整份只有一种行尾，逐字节比对因此恒不相等，
  // 每次刷新都推一份近全文 didChange。见 docs/development/memory-pressure.md。
  it('is a no-op when the text differs only in line endings', () => {
    const model = new FakeModel('one\r\ntwo\r\nthree\r\n')
    const disk = 'one\r\ntwo\nthree\n'
    expect(applyMinimalTextEdit(model, disk)).toBe('noop')
    expect(model.edits).toHaveLength(0)
    expect(model.setValueCalls).toBe(0)
  })

  it('reconciles an appended line as one small edit', () => {
    const model = new FakeModel('one\r\ntwo\r\nthree\r\n')
    expect(applyMinimalTextEdit(model, 'one\ntwo\nthree\nfour\n')).toBe('edited')
    expect(model.edits).toHaveLength(1)
    expect(model.edits[0]).toEqual({
      range: { startLineNumber: 4, startColumn: 1, endLineNumber: 4, endColumn: 1 },
      text: 'four\r\n',
    })
    expect(model.getValue()).toBe('one\r\ntwo\r\nthree\r\nfour\r\n')
  })

  // 同一缺陷的失败形状：中间一条裸 LF 会让公共前缀停在那里，于是靠近末尾的一处改动变成整篇替换
  // （编辑偏移还算在了模型并不存在的文本上）。
  it('confines the edit to the changed line despite a bare LF earlier in the file', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}\r\n`)
    const model = new FakeModel(lines.join(''))
    const disk = lines.map((l, i) => (i === 49 ? 'line 49\n' : l)).join('')
    const diskChanged = disk.replace('line 90', 'line 90 CHANGED')
    expect(applyMinimalTextEdit(model, diskChanged)).toBe('edited')
    expect(model.edits).toHaveLength(1)
    const edit = model.edits[0]!
    // "line 90" is the 91st line; the bare LF on line 50 must not widen the edit.
    expect(edit.range.startLineNumber).toBe(91)
    expect(edit.range.endLineNumber).toBe(91)
    expect(edit.text).toBe(' CHANGED')
    expect(model.getValue()).toBe(diskChanged.replace(/\r\n|\r|\n/g, '\r\n'))
  })

  it('keeps offsets exact across a CRLF boundary with CJK and emoji', () => {
    const model = new FakeModel('第一行\r\n😀 emoji 行\r\n末行\r\n')
    const disk = '第一行\n😀 emoji 行\n末行\n追加 🎮\n'
    expect(applyMinimalTextEdit(model, disk)).toBe('edited')
    expect(model.edits).toHaveLength(1)
    // Insertion at the very end: line 4 is the model's (empty) last line, never a
    // column inside the CRLF pair of line 3.
    expect(model.edits[0]).toEqual({
      range: { startLineNumber: 4, startColumn: 1, endLineNumber: 4, endColumn: 1 },
      text: '追加 🎮\r\n',
    })
    expect(model.getValue()).toBe('第一行\r\n😀 emoji 行\r\n末行\r\n追加 🎮\r\n')
  })

  it('keeps the raw comparison when the model cannot report its EOL', () => {
    let value = 'one\r\ntwo\r\n'
    const bare: IEditableTextModel = {
      getValue: () => value,
      setValue: (v: string) => {
        value = v
      },
    }
    // No getEOL() → no normalisation → the EOL-only difference still rewrites.
    expect(applyMinimalTextEdit(bare, 'one\ntwo\n')).toBe('replaced')
    expect(value).toBe('one\ntwo\n')
  })
})
