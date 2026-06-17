/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  minimalModelEdit — reconcile an open text model to new content with a single
 *  minimal edit instead of `setValue`. `setValue` flushes the model (fires a
 *  content change with `isFlush`), which makes Monaco's folding/decoration
 *  controllers drop all collapsed regions. A normal edit that touches only the
 *  changed span keeps every line outside it untouched, so folding there survives
 *  — exactly what an external reload of an unedited config file should do.
 *--------------------------------------------------------------------------------------------*/

export interface MinimalTextEdit {
  /** Character offset into the old text where the replacement starts. */
  readonly start: number
  /** Character offset into the old text where the replacement ends (exclusive). */
  readonly end: number
  /** Text inserted in place of `[start, end)`. */
  readonly text: string
}

/**
 * The single contiguous span that differs between `oldText` and `newText`,
 * trimming the shared prefix and suffix (UTF-16 code units). Returns null when
 * the texts are identical. `oldText.slice(0, start) + text + oldText.slice(end)`
 * always reconstructs `newText`.
 */
export function computeMinimalTextEdit(oldText: string, newText: string): MinimalTextEdit | null {
  if (oldText === newText) return null
  const oldLen = oldText.length
  const newLen = newText.length

  let prefix = 0
  const maxPrefix = Math.min(oldLen, newLen)
  while (prefix < maxPrefix && oldText.charCodeAt(prefix) === newText.charCodeAt(prefix)) prefix++

  let suffix = 0
  const maxSuffix = Math.min(oldLen - prefix, newLen - prefix)
  while (
    suffix < maxSuffix &&
    oldText.charCodeAt(oldLen - 1 - suffix) === newText.charCodeAt(newLen - 1 - suffix)
  ) {
    suffix++
  }

  return { start: prefix, end: oldLen - suffix, text: newText.slice(prefix, newLen - suffix) }
}

interface IPositionLike {
  readonly lineNumber: number
  readonly column: number
}

/** The slice of `monaco.editor.ITextModel` this module needs. Signatures are
 *  intentionally loose so the real model (and a test fake) both satisfy it. */
export interface IEditableTextModel {
  getValue(): string
  setValue(value: string): void
  getPositionAt?(offset: number): IPositionLike
  pushEditOperations?(
    base: never[] | null,
    edits: Array<{
      range: {
        startLineNumber: number
        startColumn: number
        endLineNumber: number
        endColumn: number
      }
      text: string
    }>,
    cursorComputer: () => null,
  ): unknown
}

export type ApplyResult = 'edited' | 'noop' | 'replaced'

/**
 * Update `model` to `newText`. Prefers a single minimal edit (preserving folding
 * outside the change); returns 'edited'. Returns 'noop' when already equal, and
 * falls back to `setValue` (returning 'replaced') when the model lacks the edit
 * APIs.
 */
export function applyMinimalTextEdit(model: IEditableTextModel, newText: string): ApplyResult {
  const edit = computeMinimalTextEdit(model.getValue(), newText)
  if (!edit) return 'noop'
  if (typeof model.getPositionAt !== 'function' || typeof model.pushEditOperations !== 'function') {
    model.setValue(newText)
    return 'replaced'
  }
  const startPos = model.getPositionAt(edit.start)
  const endPos = model.getPositionAt(edit.end)
  model.pushEditOperations(
    null,
    [
      {
        range: {
          startLineNumber: startPos.lineNumber,
          startColumn: startPos.column,
          endLineNumber: endPos.lineNumber,
          endColumn: endPos.column,
        },
        text: edit.text,
      },
    ],
    () => null,
  )
  return 'edited'
}
