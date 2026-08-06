/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  findWordAtCursor — jump to the next/previous occurrence of the word at the
 *  cursor (or the single-line selection) without opening the find widget.
 *  Ported from the VSCode extension findWordAtCursor:
 *  - collapsed selection → strict search: whole word, case sensitive; the
 *    cursor lands at the same relative column inside the matched word.
 *  - single-line selection → loose search: substring, case insensitive; the
 *    match is selected and marked with a transient highlight that clears on
 *    the next cursor move.
 *  Search wraps around the document; when the needle is the only occurrence a
 *  "No more matches." notification is shown by the caller.
 *--------------------------------------------------------------------------------------------*/

import type { monaco } from '../../workbench/editor/monaco/MonacoLoader.js'

type ITextModel = monaco.editor.ITextModel
type IStandaloneCodeEditor = monaco.editor.IStandaloneCodeEditor

const FIND_MATCHES_LIMIT = 100_000

export interface FindWordNeedle {
  readonly mode: 'strict' | 'loose'
  readonly text: string
  readonly matchCase: boolean
  /** Offset of the needle's own start — the ring anchor, NOT the cursor offset. */
  readonly referenceOffset: number
  /** strict: cursor column minus the word's start column; loose: 0 (match gets selected). */
  readonly cursorDelta: number
}

export interface FindWordMatch {
  readonly range: monaco.IRange
  readonly startOffset: number
}

export function computeNeedle(
  model: ITextModel,
  selection: monaco.Selection,
): FindWordNeedle | undefined {
  if (selection.isEmpty()) {
    const position = selection.getPosition()
    const word = model.getWordAtPosition(position)
    if (!word || word.word.length === 0) return undefined
    return {
      mode: 'strict',
      text: word.word,
      matchCase: true,
      referenceOffset: model.getOffsetAt({
        lineNumber: position.lineNumber,
        column: word.startColumn,
      }),
      cursorDelta: position.column - word.startColumn,
    }
  }
  if (selection.startLineNumber !== selection.endLineNumber) return undefined
  const text = model.getValueInRange(selection)
  if (!text || text.includes('\n')) return undefined
  return {
    mode: 'loose',
    text,
    matchCase: false,
    referenceOffset: model.getOffsetAt(selection.getStartPosition()),
    cursorDelta: 0,
  }
}

export function collectMatches(model: ITextModel, needle: FindWordNeedle): FindWordMatch[] {
  const found = model.findMatches(
    needle.text,
    false,
    false,
    needle.matchCase,
    null,
    false,
    FIND_MATCHES_LIMIT,
  )
  const matches: FindWordMatch[] = []
  for (const { range } of found) {
    if (needle.mode === 'strict') {
      const word = model.getWordAtPosition(range.getStartPosition())
      if (word?.word !== needle.text) continue
    }
    matches.push({
      range: {
        startLineNumber: range.startLineNumber,
        startColumn: range.startColumn,
        endLineNumber: range.endLineNumber,
        endColumn: range.endColumn,
      },
      startOffset: model.getOffsetAt(range.getStartPosition()),
    })
  }
  return matches
}

export function pickTarget(
  matches: readonly FindWordMatch[],
  needle: FindWordNeedle,
  direction: 1 | -1,
): FindWordMatch | undefined {
  if (matches.length === 0) return undefined
  let target: FindWordMatch | undefined
  if (direction === 1) {
    target = matches.find((m) => m.startOffset > needle.referenceOffset) ?? matches[0]
  } else {
    for (const m of matches) {
      if (m.startOffset >= needle.referenceOffset) break
      target = m
    }
    target = target ?? matches[matches.length - 1]
  }
  // Wrapped all the way back onto the needle itself: it is the only occurrence.
  return target && target.startOffset !== needle.referenceOffset ? target : undefined
}

interface HighlightEntry {
  readonly collection: monaco.editor.IEditorDecorationsCollection
  listener: monaco.IDisposable | undefined
}

class FindWordHighlightController {
  private readonly _entries = new WeakMap<IStandaloneCodeEditor, HighlightEntry>()

  show(editor: IStandaloneCodeEditor, range: monaco.IRange): void {
    const entry = this._entry(editor)
    entry.collection.clear()
    entry.collection.set([{ range, options: { className: 'findWordAtCursorMatch' } }])
  }

  /** Must be called AFTER the jump's own setSelection: Monaco fires
   *  onDidChangeCursorSelection synchronously, so arming earlier would let the
   *  jump itself wipe the highlight it just painted. */
  armClearOnSelectionChange(editor: IStandaloneCodeEditor): void {
    const entry = this._entries.get(editor)
    if (!entry || entry.listener) return
    entry.listener = editor.onDidChangeCursorSelection(() => this.clear(editor))
  }

  clear(editor: IStandaloneCodeEditor): void {
    const entry = this._entries.get(editor)
    if (!entry) return
    entry.listener?.dispose()
    entry.listener = undefined
    entry.collection.clear()
  }

  private _entry(editor: IStandaloneCodeEditor): HighlightEntry {
    let entry = this._entries.get(editor)
    if (!entry) {
      entry = { collection: editor.createDecorationsCollection(), listener: undefined }
      this._entries.set(editor, entry)
    }
    return entry
  }
}

export const findWordHighlightController = new FindWordHighlightController()
