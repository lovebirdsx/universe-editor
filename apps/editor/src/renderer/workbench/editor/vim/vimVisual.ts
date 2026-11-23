/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Visual mode, pure parts. The controller keeps the selection as an anchor + cursor
 *  pair of *on-character* positions (Vim's model: the cursor char is part of the
 *  selection); this module turns that pair into the Monaco selections that render
 *  it and into the range an operator acts on. Keeping the pair — instead of reading
 *  Monaco's selection back — is what lets `o` swap ends and the selection stay
 *  inclusive in both directions.
 *
 *  `VISUAL_ACTION_KEYS` is the table behind Visual-mode `d`/`y`/`c`/`~`… : one entry
 *  per key, no switch in the reducer.
 *--------------------------------------------------------------------------------------------*/

import { clampNormalPosition, lineLength } from './vimMotions.js'
import { buildOperatorRange, linewiseOperatorRange, type VimOperatorRange } from './vimOperators.js'
import {
  comparePositions,
  type VimLineReader,
  type VimMotion,
  type VimPosition,
  type VimRange,
  type VimSelection,
  type VimVisualAction,
  type VimVisualExtent,
  type VimVisualMode,
} from './vimTypes.js'

export interface VimVisualSelection {
  readonly mode: VimVisualMode
  /** Where Visual started (on a character). */
  readonly anchor: VimPosition
  /** The moving end, also on a character. */
  readonly cursor: VimPosition
  /**
   * `$` was the last horizontal move, so the cursor sticks to the end of its line and the
   * selection takes the line break with it (`v$y`, `v$d`). Block mode: every row runs to
   * its own end. Only meaningful while the cursor is the later end.
   */
  readonly eol?: boolean
}

/** Vertical moves keep a sticky `$` (Vim's `curswant = MAXCOL`); every other motion drops it. */
const EOL_KEEPING_MOTIONS: ReadonlySet<VimMotion> = new Set<VimMotion>([
  'j',
  'k',
  'pageDown',
  'pageUp',
  'halfPageDown',
  'halfPageUp',
])

/** The `eol` flag of a Visual selection after it moved by `motion`. */
export function visualEolAfterMotion(previous: boolean, motion: VimMotion): boolean {
  return motion === '$' || (previous && EOL_KEEPING_MOTIONS.has(motion))
}

export interface VimVisualActionDef {
  readonly action: VimVisualAction
  /** Treat the selection as whole lines (`X`, `Y`, `S`). Ignored in block mode. */
  readonly linewise?: true
  /** Block mode: every row runs to its end (`D`, `C`). */
  readonly toEol?: true
  /** Waits for one more typed character (`r`). */
  readonly needsChar?: boolean
  readonly description: string
}

/** Visual-mode keys that act on the selection. */
export const VISUAL_ACTION_KEYS: ReadonlyMap<string, VimVisualActionDef> = new Map<
  string,
  VimVisualActionDef
>([
  ['d', { action: 'delete', description: 'Delete the selection' }],
  ['x', { action: 'delete', description: 'Delete the selection' }],
  ['X', { action: 'delete', linewise: true, description: 'Delete the selected lines' }],
  [
    'D',
    {
      action: 'delete',
      linewise: true,
      toEol: true,
      description: 'Delete the selected lines (block: to end of line)',
    },
  ],
  ['y', { action: 'yank', description: 'Yank the selection' }],
  ['Y', { action: 'yank', linewise: true, description: 'Yank the selected lines' }],
  ['c', { action: 'change', description: 'Change the selection' }],
  ['s', { action: 'change', description: 'Change the selection' }],
  [
    'C',
    {
      action: 'change',
      linewise: true,
      toEol: true,
      description: 'Change the selected lines (block: to end of line)',
    },
  ],
  ['S', { action: 'change', linewise: true, description: 'Change the selected lines' }],
  ['R', { action: 'change', linewise: true, description: 'Change the selected lines' }],
  ['>', { action: 'shift-right', description: 'Indent the selected lines' }],
  ['<', { action: 'shift-left', description: 'Outdent the selected lines' }],
  ['~', { action: 'toggle-case', description: 'Toggle case of the selection' }],
  ['u', { action: 'lower', description: 'Lowercase the selection' }],
  ['U', { action: 'upper', description: 'Uppercase the selection' }],
  ['J', { action: 'join', description: 'Join the selected lines' }],
  ['r', { action: 'replace', needsChar: true, description: 'Replace every selected character' }],
  ['p', { action: 'paste', description: 'Replace the selection with the register' }],
  [
    'P',
    { action: 'paste-keep', description: 'Replace the selection without overwriting the register' },
  ],
])

/** Keys after `g` in Visual mode that are actions (the rest of the `g` table still applies). */
export const VISUAL_G_ACTION_KEYS: ReadonlyMap<string, VimVisualActionDef> = new Map<
  string,
  VimVisualActionDef
>([
  ['J', { action: 'join-nospace', description: 'Join the selected lines without spaces' }],
  ['u', { action: 'lower', description: 'Lowercase the selection' }],
  ['U', { action: 'upper', description: 'Uppercase the selection' }],
  ['~', { action: 'toggle-case', description: 'Toggle case of the selection' }],
])

export function orderedEnds(selection: VimVisualSelection): [VimPosition, VimPosition] {
  return comparePositions(selection.anchor, selection.cursor) <= 0
    ? [selection.anchor, selection.cursor]
    : [selection.cursor, selection.anchor]
}

/** Column range [left, right] (inclusive, on characters) covered by a block selection. */
function blockColumns(selection: VimVisualSelection): { left: number; right: number } {
  return {
    left: Math.min(selection.anchor.column, selection.cursor.column),
    right: Math.max(selection.anchor.column, selection.cursor.column),
  }
}

/** One range per row of a block selection; a row shorter than the block yields an empty range. */
function blockRanges(
  lines: VimLineReader,
  selection: VimVisualSelection,
  toEol = false,
): VimRange[] {
  const { left, right } = blockColumns(selection)
  const top = Math.min(selection.anchor.line, selection.cursor.line)
  const bottom = Math.max(selection.anchor.line, selection.cursor.line)
  const ranges: VimRange[] = []
  const rowToEol = toEol || selection.eol === true
  for (let line = top; line <= bottom; line++) {
    const length = lineLength(lines, line)
    // A row that ends before the block starts has nothing in it.
    if (left > length + 1) continue
    const startColumn = left
    const endColumn = rowToEol ? length + 1 : Math.min(right + 1, length + 1)
    ranges.push({
      startLineNumber: line,
      startColumn,
      endLineNumber: line,
      endColumn: Math.max(startColumn, endColumn),
    })
  }
  return ranges
}

/** `v$` on a line that has a successor: the selection ends after the line break. */
function stickyBreakIncluded(lines: VimLineReader, selection: VimVisualSelection): boolean {
  return (
    selection.eol === true &&
    selection.cursor.line < lines.getLineCount() &&
    comparePositions(selection.cursor, selection.anchor) >= 0
  )
}

/** The Monaco selections that paint a Visual selection; the first is the primary (cursor) one. */
export function visualMonacoSelections(
  lines: VimLineReader,
  selection: VimVisualSelection,
): VimSelection[] {
  const { anchor, cursor, mode } = selection
  const forward = comparePositions(cursor, anchor) >= 0
  if (mode === 'visual-line') {
    return [
      forward
        ? {
            selectionStartLineNumber: anchor.line,
            selectionStartColumn: 1,
            positionLineNumber: cursor.line,
            positionColumn: lineLength(lines, cursor.line) + 1,
          }
        : {
            selectionStartLineNumber: anchor.line,
            selectionStartColumn: lineLength(lines, anchor.line) + 1,
            positionLineNumber: cursor.line,
            positionColumn: 1,
          },
    ]
  }
  if (mode === 'visual') {
    // Monaco selections are half-open; the char under the far end is selected too.
    const breakIncluded = forward && stickyBreakIncluded(lines, selection)
    return [
      forward
        ? {
            selectionStartLineNumber: anchor.line,
            selectionStartColumn: anchor.column,
            positionLineNumber: breakIncluded ? cursor.line + 1 : cursor.line,
            positionColumn: breakIncluded
              ? 1
              : Math.min(lineLength(lines, cursor.line) + 1, cursor.column + 1),
          }
        : {
            selectionStartLineNumber: anchor.line,
            selectionStartColumn: Math.min(lineLength(lines, anchor.line) + 1, anchor.column + 1),
            positionLineNumber: cursor.line,
            positionColumn: cursor.column,
          },
    ]
  }
  const rows = blockRanges(lines, selection)
  const cursorLeft = cursor.column <= anchor.column
  const selections = rows.map<VimSelection>((range) =>
    cursorLeft
      ? {
          selectionStartLineNumber: range.endLineNumber,
          selectionStartColumn: range.endColumn,
          positionLineNumber: range.startLineNumber,
          positionColumn: range.startColumn,
        }
      : {
          selectionStartLineNumber: range.startLineNumber,
          selectionStartColumn: range.startColumn,
          positionLineNumber: range.endLineNumber,
          positionColumn: range.endColumn,
        },
  )
  // Monaco treats the first selection as the primary cursor: keep the cursor row there.
  const primary = selections.findIndex((item) => item.positionLineNumber === cursor.line)
  if (primary > 0) {
    const [row] = selections.splice(primary, 1)
    selections.unshift(row!)
  }
  return selections
}

/** The range an operator acts on for the current selection (the cursor char is included). */
export function visualOperatorRange(
  lines: VimLineReader,
  selection: VimVisualSelection,
  options: { readonly linewise?: boolean; readonly toEol?: boolean } = {},
): VimOperatorRange {
  const lineCount = lines.getLineCount()
  if (selection.mode === 'visual-block') {
    const rows = blockRanges(lines, selection, options.toEol === true)
    const first = rows[0]!
    const last = rows[rows.length - 1]!
    return {
      range: {
        startLineNumber: first.startLineNumber,
        startColumn: first.startColumn,
        endLineNumber: last.endLineNumber,
        endColumn: last.endColumn,
      },
      linewise: false,
      startLine: first.startLineNumber,
      endLine: last.endLineNumber,
      blocks: rows,
    }
  }
  if (selection.mode === 'visual-line' || options.linewise === true) {
    return linewiseOperatorRange(lines, selection.anchor.line, selection.cursor.line)
  }
  const [start, end] = orderedEnds(selection)
  const built = buildOperatorRange(lines, start, { to: end, kind: 'inclusive' })
  // Selecting an empty line selects its line break (`vd` on a blank line joins it away);
  // so does a sticky `$` (`v$d` joins the next line).
  if (
    end.line < lineCount &&
    (lineLength(lines, end.line) === 0 || stickyBreakIncluded(lines, selection))
  ) {
    return {
      ...built,
      range: { ...built.range, endLineNumber: end.line + 1, endColumn: 1 },
    }
  }
  return built
}

/** Where Block `I` / `A` put their cursors: every row that reaches the block's edge. */
export function blockInsertPositions(
  lines: VimLineReader,
  selection: VimVisualSelection,
  at: 'start' | 'end',
): VimPosition[] {
  const { left, right } = blockColumns(selection)
  const top = Math.min(selection.anchor.line, selection.cursor.line)
  const bottom = Math.max(selection.anchor.line, selection.cursor.line)
  const positions: VimPosition[] = []
  for (let line = top; line <= bottom; line++) {
    const length = lineLength(lines, line)
    if (at === 'start') {
      // `I` skips rows that end before the block starts.
      if (left <= length + 1) positions.push({ line, column: left })
    } else {
      positions.push({
        line,
        column: selection.eol === true ? length + 1 : Math.min(right + 1, length + 1),
      })
    }
  }
  return positions
}

/** How much text a selection covers, so `.` can replay a Visual operator over as much. */
export function visualExtent(selection: VimVisualSelection): VimVisualExtent {
  const [start, end] = orderedEnds(selection)
  const lines = end.line - start.line + 1
  if (selection.mode === 'visual-line') return { mode: selection.mode, lines, columns: 0 }
  if (selection.mode === 'visual-block') {
    const { left, right } = blockColumns(selection)
    return { mode: selection.mode, lines, columns: right - left + 1 }
  }
  return {
    mode: selection.mode,
    lines,
    columns: lines === 1 ? end.column - start.column + 1 : end.column,
  }
}

/** A fresh selection of `extent`'s size starting at `from`. */
export function selectionFromExtent(
  lines: VimLineReader,
  from: VimPosition,
  extent: VimVisualExtent,
): VimVisualSelection {
  const lastLine = Math.min(lines.getLineCount(), from.line + extent.lines - 1)
  const clamp = (position: VimPosition) => clampNormalPosition(lines, position)
  let cursor: VimPosition
  if (extent.mode === 'visual-line') cursor = { line: lastLine, column: from.column }
  else if (extent.mode === 'visual-block') {
    cursor = { line: lastLine, column: from.column + extent.columns - 1 }
  } else if (extent.lines === 1) {
    cursor = { line: from.line, column: from.column + extent.columns - 1 }
  } else cursor = { line: lastLine, column: extent.columns }
  return { mode: extent.mode, anchor: from, cursor: clamp(cursor) }
}
