/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for minimalModelEdit — reconciling a model to new content with a single
 *  minimal edit (preserving folding outside the change) instead of setValue.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  applyMinimalTextEdit,
  computeMinimalTextEdit,
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

/**
 * Minimal in-memory stand-in for an editable Monaco model: tracks its value and
 * records whether a reconcile went through pushEditOperations (a real edit) or
 * setValue (a flush). Offset→position uses the same line/column math as Monaco.
 */
class FakeModel implements IEditableTextModel {
  setValueCalls = 0
  edits: RecordedEdit[] = []
  constructor(private _value: string) {}

  getValue(): string {
    return this._value
  }

  setValue(value: string): void {
    this.setValueCalls++
    this._value = value
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
      // Apply by reconstructing offsets so getValue() stays correct.
      const start = this._offsetOf(e.range.startLineNumber, e.range.startColumn)
      const end = this._offsetOf(e.range.endLineNumber, e.range.endColumn)
      this._value = this._value.slice(0, start) + e.text + this._value.slice(end)
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
