/**
 * Shared primitives for the markdown editing commands. All commands follow the
 * same shape: fetch the active editor, read its lines + selections, compute a
 * pure result, then apply it. Coordinates are LSP-shaped (0-based) throughout,
 * matching `@universe-editor/extension-api`.
 */
import {
  window,
  type Position,
  type Range,
  type Selection,
  type TextEditor,
} from '@universe-editor/extension-api'

export type { Selection }

export interface EditOp {
  readonly range: Range
  readonly text: string
}

/** A computed change set: edits to apply plus the selections to leave behind. */
export interface EditResult {
  readonly edits: readonly EditOp[]
  readonly selections?: readonly Selection[]
}

export function pos(line: number, character: number): Position {
  return { line, character }
}

export function range(
  startLine: number,
  startChar: number,
  endLine: number,
  endChar: number,
): Range {
  return { start: pos(startLine, startChar), end: pos(endLine, endChar) }
}

export function selection(anchor: Position, active: Position): Selection {
  return { anchor, active }
}

/** A point selection (empty) at a single position. */
export function cursor(line: number, character: number): Selection {
  const p = pos(line, character)
  return { anchor: p, active: p }
}

export function isEmpty(sel: Selection): boolean {
  return sel.anchor.line === sel.active.line && sel.anchor.character === sel.active.character
}

/** Order a selection's two ends as [start, end] regardless of direction. */
export function ordered(sel: Selection): { start: Position; end: Position } {
  const a = sel.anchor
  const b = sel.active
  if (a.line < b.line || (a.line === b.line && a.character <= b.character)) {
    return { start: a, end: b }
  }
  return { start: b, end: a }
}

/** The active markdown editor split into lines, or undefined when none is focused. */
export interface ActiveMarkdown {
  readonly editor: TextEditor
  readonly lines: string[]
  readonly selections: readonly Selection[]
}

/** Split document text into lines, tolerating CRLF / CR / LF endings. Monaco's
 *  line content never includes the terminator, so the per-line lengths produced
 *  here line up with the editor's columns. */
export function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/)
}

export async function activeMarkdown(): Promise<ActiveMarkdown | undefined> {
  const editor = await window.getActiveTextEditor()
  if (!editor || editor.document.languageId !== 'markdown') return undefined
  return {
    editor,
    lines: splitLines(editor.document.getText()),
    selections: editor.selections,
  }
}

/** Apply a computed result to the editor as one undo step, then place selections. */
export async function applyResult(editor: TextEditor, result: EditResult): Promise<void> {
  if (result.edits.length === 0) {
    if (result.selections && result.selections.length > 0) {
      await editor.setSelections(result.selections)
    }
    return
  }
  const ok = await editor.edit((builder) => {
    for (const e of result.edits) builder.replace(e.range, e.text)
  })
  if (ok && result.selections && result.selections.length > 0) {
    await editor.setSelections(result.selections)
  }
}

/** Replace the full text of a single line (0-based). */
export function replaceLine(lineIndex: number, lineText: string, newText: string): EditOp {
  return { range: range(lineIndex, 0, lineIndex, lineText.length), text: newText }
}
