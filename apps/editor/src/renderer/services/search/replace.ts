/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Replace helpers — pure functions used by SearchView's replace path.
 *
 *  Applies a set of column-bounded replacements to a text buffer. Replacements
 *  are sorted by (line desc, startColumn desc) so each edit is splice'd into a
 *  region that hasn't been touched yet, keeping the remaining 1-based column
 *  offsets valid throughout.
 *--------------------------------------------------------------------------------------------*/

export interface IReplaceEdit {
  /** 1-based line number. */
  readonly line: number
  /** 1-based column where the match starts (inclusive). */
  readonly startColumn: number
  /** 1-based column one past the last matched character (exclusive). */
  readonly endColumn: number
  readonly replaceText: string
}

/**
 * Apply edits to a multi-line text buffer. The input is split on `\n` so
 * `\r\n` line endings survive (the trailing `\r` stays in the line). Edits
 * that fall outside the line range, or whose columns are inverted, are
 * silently skipped — callers should pre-validate when that matters.
 */
export function applyReplacements(text: string, edits: readonly IReplaceEdit[]): string {
  if (edits.length === 0) return text
  const lines = text.split('\n')
  // Group edits by line.
  const byLine = new Map<number, IReplaceEdit[]>()
  for (const e of edits) {
    if (e.line < 1 || e.line > lines.length) continue
    if (e.endColumn < e.startColumn) continue
    const list = byLine.get(e.line) ?? []
    list.push(e)
    byLine.set(e.line, list)
  }
  for (const [line, list] of byLine) {
    list.sort((a, b) => b.startColumn - a.startColumn)
    let buf = lines[line - 1]!
    for (const e of list) {
      const start = Math.max(e.startColumn - 1, 0)
      const end = Math.min(Math.max(e.endColumn - 1, start), buf.length)
      buf = buf.slice(0, start) + e.replaceText + buf.slice(end)
    }
    lines[line - 1] = buf
  }
  return lines.join('\n')
}
