/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Vim motions over plain line arrays. Normal-mode columns are 1-based and stop
 *  on the last *character* of a line (`$` is the last character, not the insert
 *  position after it). Word classes follow Vim's `iskeyword` default plus any
 *  letter/number — CJK text therefore forms words instead of one-character hops.
 *--------------------------------------------------------------------------------------------*/

import type { VimMotion, VimPosition } from './vimTypes.js'

export type VimCharClass = 'blank' | 'keyword' | 'punct'

export function classifyChar(ch: string): VimCharClass {
  if (ch === '' || /\s/.test(ch)) return 'blank'
  return /[\p{L}\p{N}_]/u.test(ch) ? 'keyword' : 'punct'
}

export function lineLength(lines: readonly string[], line: number): number {
  return lines[line - 1]?.length ?? 0
}

export function firstNonBlankColumn(text: string): number {
  for (let i = 0; i < text.length; i++) {
    if (!/\s/.test(text[i]!)) return i + 1
  }
  return 1
}

/** Clamp a normal-mode position onto a real character (empty lines sit at column 1). */
export function clampNormalPosition(lines: readonly string[], position: VimPosition): VimPosition {
  const lineCount = lines.length
  if (lineCount === 0) return { line: 1, column: 1 }
  const line = Math.max(1, Math.min(lineCount, position.line))
  const len = lineLength(lines, line)
  const column = len === 0 ? 1 : Math.max(1, Math.min(len, position.column))
  return { line, column }
}

interface FlatChar {
  readonly ch: string
  readonly line: number
  readonly column: number
  readonly newline: boolean
}

function flatten(lines: readonly string[]): FlatChar[] {
  const out: FlatChar[] = []
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i] ?? ''
    for (let c = 0; c < text.length; c++) {
      out.push({ ch: text[c]!, line: i + 1, column: c + 1, newline: false })
    }
    if (i < lines.length - 1) {
      out.push({ ch: '\n', line: i + 1, column: text.length + 1, newline: true })
    }
  }
  return out
}

function indexOfPosition(
  flat: readonly FlatChar[],
  lines: readonly string[],
  pos: VimPosition,
): number {
  // Binary-search the line-start offset, then offset within the line.
  let start = 0
  for (let line = 1; line < pos.line && line <= lines.length; line++) {
    start += (lines[line - 1]?.length ?? 0) + 1
  }
  const columnOffset = Math.max(0, Math.min(lineLength(lines, pos.line) - 1, pos.column - 1))
  return Math.min(flat.length - 1, Math.max(0, start + columnOffset))
}

function classAt(flat: readonly FlatChar[], index: number, bigWord: boolean): VimCharClass {
  const ch = flat[index]?.ch ?? ''
  if (bigWord) return ch === '' || /\s/.test(ch) ? 'blank' : 'keyword'
  return classifyChar(ch)
}

function moveWordForward(
  flat: readonly FlatChar[],
  start: number,
  count: number,
  bigWord: boolean,
): number {
  let i = start
  for (let n = 0; n < count; n++) {
    if (i >= flat.length - 1) return flat.length - 1
    if (classAt(flat, i, bigWord) !== 'blank') {
      const current = classAt(flat, i, bigWord)
      while (i + 1 < flat.length && classAt(flat, i + 1, bigWord) === current) i++
    }
    while (i + 1 < flat.length && classAt(flat, i + 1, bigWord) === 'blank') i++
    if (i + 1 < flat.length) i++
  }
  return i
}

function moveWordEnd(
  flat: readonly FlatChar[],
  start: number,
  count: number,
  bigWord: boolean,
): number {
  let i = start
  for (let n = 0; n < count; n++) {
    if (i + 1 < flat.length) i++
    while (i < flat.length && classAt(flat, i, bigWord) === 'blank') i++
    if (i >= flat.length) return flat.length - 1
    const current = classAt(flat, i, bigWord)
    while (i + 1 < flat.length && classAt(flat, i + 1, bigWord) === current) i++
  }
  return i
}

function moveWordBackward(
  flat: readonly FlatChar[],
  start: number,
  count: number,
  bigWord: boolean,
): number {
  let i = start
  for (let n = 0; n < count; n++) {
    if (i > 0) i--
    while (i > 0 && classAt(flat, i, bigWord) === 'blank') i--
    const current = classAt(flat, i, bigWord)
    while (i > 0 && classAt(flat, i - 1, bigWord) === current) i--
  }
  return i
}

function flatToPosition(
  flat: readonly FlatChar[],
  index: number,
  lines: readonly string[],
): VimPosition {
  const f = flat[index]
  if (f === undefined) {
    const lastLine = Math.max(1, lines.length)
    return { line: lastLine, column: Math.max(1, lineLength(lines, lastLine)) }
  }
  if (f.newline) {
    // A motion never rests on a line break; clamp onto the last character.
    const len = lineLength(lines, f.line)
    return { line: f.line, column: Math.max(1, len) }
  }
  return { line: f.line, column: f.column }
}

function paragraphBoundary(lines: readonly string[], from: number, direction: 1 | -1): number {
  for (let line = from + direction; line >= 1 && line <= lines.length; line += direction) {
    if ((lines[line - 1] ?? '').trim() === '') return line
  }
  return direction === 1 ? lines.length : 1
}

/**
 * Resolve a text motion to its destination. Paging motions return `null`; the
 * controller hands those to Monaco's own `cursorPageDown`/`cursorPageUp` so
 * viewport-relative movement stays consistent with the renderer.
 */
export function resolveMotion(
  lines: readonly string[],
  from: VimPosition,
  motion: VimMotion,
  count: number,
): VimPosition | null {
  const steps = Math.max(1, count)
  switch (motion) {
    case 'h':
      return clampNormalPosition(lines, { line: from.line, column: from.column - steps })
    case 'l':
      return clampNormalPosition(lines, { line: from.line, column: from.column + steps })
    case 'j':
      return clampNormalPosition(lines, { line: from.line + steps, column: from.column })
    case 'k':
      return clampNormalPosition(lines, { line: from.line - steps, column: from.column })
    case '0':
      return clampNormalPosition(lines, { line: from.line, column: 1 })
    case '^':
      return clampNormalPosition(lines, {
        line: from.line,
        column: firstNonBlankColumn(lines[from.line - 1] ?? ''),
      })
    case '$': {
      // `N$` drops N-1 lines first, then stops on the last character there.
      const line = Math.max(1, Math.min(lines.length, from.line + steps - 1))
      const len = lineLength(lines, line)
      return clampNormalPosition(lines, { line, column: Math.max(1, len) })
    }
    case 'gg':
      return clampNormalPosition(lines, {
        // A count is a line number for gg/G, not a repetition.
        line: count > 0 ? count : 1,
        column: firstNonBlankColumn(lines[(count > 0 ? count : 1) - 1] ?? ''),
      })
    case 'G': {
      const lastLine = Math.max(1, lines.length)
      const targetLine = count > 0 ? Math.min(count, lastLine) : lastLine
      return clampNormalPosition(lines, {
        line: targetLine,
        column: firstNonBlankColumn(lines[targetLine - 1] ?? ''),
      })
    }
    case 'enter': {
      // `<CR>` (`+`): down `steps` lines onto the first non-blank. At EOF the
      // motion fails and the cursor stays put.
      if (from.line >= lines.length) return clampNormalPosition(lines, from)
      const targetLine = Math.min(lines.length, from.line + steps)
      return {
        line: targetLine,
        column: firstNonBlankColumn(lines[targetLine - 1] ?? ''),
      }
    }
    case '{':
      return clampNormalPosition(lines, {
        line: paragraphBoundary(lines, from.line, -1),
        column: 1,
      })
    case '}':
      return clampNormalPosition(lines, {
        line: paragraphBoundary(lines, from.line, 1),
        column: 1,
      })
    case 'w':
    case 'W':
    case 'b':
    case 'B':
    case 'e':
    case 'E': {
      const flat = flatten(lines)
      if (flat.length === 0) return clampNormalPosition(lines, from)
      const start = indexOfPosition(flat, lines, from)
      const bigWord = motion === 'W' || motion === 'B' || motion === 'E'
      const index =
        motion === 'w' || motion === 'W'
          ? moveWordForward(flat, start, steps, bigWord)
          : motion === 'e' || motion === 'E'
            ? moveWordEnd(flat, start, steps, bigWord)
            : moveWordBackward(flat, start, steps, bigWord)
      return clampNormalPosition(lines, flatToPosition(flat, index, lines))
    }
    case 'pageDown':
    case 'pageUp':
    case 'halfPageDown':
    case 'halfPageUp':
      return null
  }
}
