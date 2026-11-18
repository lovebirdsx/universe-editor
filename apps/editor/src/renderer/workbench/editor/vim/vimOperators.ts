/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Operator + motion range building. A deliberately small, predictable subset:
 *  `dd/yy` (lines), `d$/y$`, `dw/yw`, `db/yb`, `de/ye`, and the
 *  linewise motions `dj/dk/dgg/dG`. Whole-line ranges include the trailing line
 *  break except at EOF, where the leading break is removed instead so a `dd` on
 *  the last line really deletes the line rather than leaving a blank one.
 *--------------------------------------------------------------------------------------------*/

import { lineLength, resolveMotion } from './vimMotions.js'
import type { VimMotion, VimPosition, VimRange } from './vimTypes.js'

export interface VimOperatorRange {
  readonly range: VimRange
  readonly linewise: boolean
}

function comparePositions(a: VimPosition, b: VimPosition): number {
  if (a.line !== b.line) return a.line - b.line
  return a.column - b.column
}

export function linewiseRange(
  lines: readonly string[],
  startLine: number,
  endLine: number,
): VimRange {
  const lineCount = lines.length
  const start = Math.max(1, Math.min(lineCount, startLine))
  const end = Math.max(start, Math.min(lineCount, endLine))
  // Deleting through EOF has no trailing break to consume; remove the leading
  // one instead so the line itself is what disappears.
  if (end < lineCount) {
    return { startLineNumber: start, startColumn: 1, endLineNumber: end + 1, endColumn: 1 }
  }
  const endColumn = lineLength(lines, end) + 1
  if (start > 1) {
    const previousLength = lineLength(lines, start - 1)
    return {
      startLineNumber: start - 1,
      startColumn: previousLength + 1,
      endLineNumber: end,
      endColumn,
    }
  }
  return { startLineNumber: start, startColumn: 1, endLineNumber: end, endColumn }
}

function charwiseRange(
  lines: readonly string[],
  from: VimPosition,
  to: VimPosition,
  inclusiveEnd: boolean,
  /** Backward motions differ: `b` includes the cursor character, `0`/`^` do not. */
  includeCursorWhenBackward: boolean,
): VimRange {
  const forward = comparePositions(from, to) <= 0
  if (forward) {
    // Exclusive target at a line start means "through the previous line's
    // break", matching Vim's `dw` at end of line.
    if (!inclusiveEnd && to.column === 1 && to.line > from.line) {
      return {
        startLineNumber: from.line,
        startColumn: from.column,
        endLineNumber: to.line - 1,
        endColumn: lineLength(lines, to.line - 1) + 1,
      }
    }
    const endColumn = inclusiveEnd
      ? Math.min(lineLength(lines, to.line) + 1, Math.max(1, to.column + 1))
      : Math.max(1, to.column)
    return {
      startLineNumber: from.line,
      startColumn: from.column,
      endLineNumber: to.line,
      endColumn,
    }
  }
  // Backward: `from` is the right edge, so the range is [to, from].
  const endColumn = includeCursorWhenBackward
    ? Math.min(lineLength(lines, from.line) + 1, from.column + 1)
    : Math.max(1, from.column)
  return {
    startLineNumber: to.line,
    startColumn: to.column,
    endLineNumber: from.line,
    endColumn,
  }
}

/**
 * Build the range an operator acts on. Paging motions are not supported by
 * operators here and return `null`.
 */
export function resolveOperatorRange(
  lines: readonly string[],
  from: VimPosition,
  motion: VimMotion,
  count: number,
): VimOperatorRange | null {
  const steps = Math.max(1, count)
  const target = (m: VimMotion): VimPosition | null => resolveMotion(lines, from, m, steps)

  switch (motion) {
    case 'j':
      return { range: linewiseRange(lines, from.line, from.line + steps), linewise: true }
    case 'k':
      return { range: linewiseRange(lines, from.line - steps, from.line), linewise: true }
    case 'enter': {
      const destination = target(motion)
      if (destination === null) return null
      return {
        range: linewiseRange(lines, from.line, Math.max(from.line, destination.line)),
        linewise: true,
      }
    }
    case 'gg': {
      // gg/G take a line number, not a repetition; a count may point either
      // direction from the cursor.
      const destinationLine = count > 0 ? Math.min(count, from.line) : 1
      return { range: linewiseRange(lines, destinationLine, from.line), linewise: true }
    }
    case 'G': {
      const destinationLine = count > 0 ? Math.max(count, from.line) : lines.length
      return { range: linewiseRange(lines, from.line, destinationLine), linewise: true }
    }
    case '{':
    case '}': {
      const destination = target(motion)
      if (destination === null) return null
      // Both paragraphs are exclusive: the blank line they stop on survives.
      // When no blank line exists the motion runs to the file edge, inclusive.
      const boundaryBlank = (lines[destination.line - 1] ?? '').trim() === ''
      if (motion === '}') {
        const endLine = boundaryBlank ? destination.line - 1 : destination.line
        return {
          range: linewiseRange(lines, from.line, Math.max(from.line, endLine)),
          linewise: true,
        }
      }
      const startLine = boundaryBlank ? destination.line + 1 : destination.line
      return {
        range: linewiseRange(lines, Math.min(from.line, startLine), from.line),
        linewise: true,
      }
    }
    case '$': {
      const destination = target('$')
      return destination === null
        ? null
        : { range: charwiseRange(lines, from, destination, true, true), linewise: false }
    }
    case 'w':
    case 'W': {
      const destination = target(motion)
      if (destination === null) return null
      // Exclusive, except when there is no next word start: the motion then
      // rests on the buffer's last character, which Vim deletes too.
      const atBufferEnd =
        destination.line === lines.length &&
        destination.column >= lineLength(lines, destination.line)
      return {
        range: charwiseRange(lines, from, destination, atBufferEnd, true),
        linewise: false,
      }
    }
    case 'e':
    case 'E': {
      const destination = target(motion)
      return destination === null
        ? null
        : { range: charwiseRange(lines, from, destination, true, true), linewise: false }
    }
    case 'b':
    case 'B':
    case '0':
    case '^': {
      const destination = target(motion)
      if (destination === null) return null
      return {
        range: charwiseRange(lines, from, destination, false, false),
        linewise: false,
      }
    }
    default:
      return null
  }
}
