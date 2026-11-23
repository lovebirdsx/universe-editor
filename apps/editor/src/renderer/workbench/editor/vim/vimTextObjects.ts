/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Text objects (`iw`, `a"`, `i(`, `ip`, `it`…) as a declarative registry, like the
 *  motions. Each `VimTextObjectDef` lists its keys and a `resolve` that maps the
 *  cursor to the range it covers — `end` exclusive, 1-based Monaco columns. The
 *  reducer opens an `i`/`a` prefix after an operator (and in Visual mode) and looks
 *  the second key up here; operators and Visual selection share the one `resolve`.
 *
 *  Everything reads through the lazy `VimLineReader`. Quote objects stay on the
 *  cursor line, bracket objects may span lines, tag objects scan a window of lines
 *  around the cursor. `extendVisualByTextObject` is the Visual-mode entry point.
 *--------------------------------------------------------------------------------------------*/

import { clampNormalPosition } from './vimMotions.js'
import type { VimVisualSelection } from './vimVisual.js'
import { charClassAt } from './vimWordMotions.js'
import {
  comparePositions,
  type VimLineReader,
  type VimPosition,
  type VimTextObjectId,
} from './vimTypes.js'

export interface VimTextObjectRange {
  readonly start: VimPosition
  /** Exclusive: the column just past the last character. */
  readonly end: VimPosition
  /** Whole lines: `start`/`end` lines are the first and last covered line, columns ignored. */
  readonly linewise: boolean
}

export interface VimTextObjectContext {
  readonly lines: VimLineReader
  readonly cursor: VimPosition
  readonly around: boolean
  readonly count: number
}

export interface VimTextObjectDef {
  readonly id: VimTextObjectId
  /** Keys that select it (`)` and `b` both select the parenthesis object). */
  readonly keys: readonly string[]
  /** One-line help text; `around` is "a…", otherwise "i…" (English; localized by `vimKeyHelp.ts`). */
  readonly description: string
  /**
   * Objects that nest (brackets, tags): the `count`-th one out. Repeating them in Visual
   * mode climbs to the enclosing one by raising the count.
   */
  readonly nests?: true
  readonly resolve: (ctx: VimTextObjectContext) => VimTextObjectRange | null
}

function steps(count: number): number {
  return Math.max(1, count)
}

function charRange(line: number, startColumn: number, endColumn: number): VimTextObjectRange {
  return {
    start: { line, column: startColumn },
    end: { line, column: endColumn },
    linewise: false,
  }
}

function isBlankLine(lines: VimLineReader, line: number): boolean {
  return lines.getLineContent(line).trim() === ''
}

// ── words ────────────────────────────────────────────────────────────────────

function wordObject(id: 'w' | 'W'): VimTextObjectDef {
  const bigWord = id === 'W'
  return {
    id,
    keys: [id],
    description: bigWord ? 'WORD (whitespace-separated)' : 'word',
    resolve({ lines, cursor, around, count }) {
      const text = lines.getLineContent(cursor.line)
      if (text.length === 0) return null
      const classAt = (index: number) => charClassAt(text, index, bigWord)
      const runEnd = (index: number): number => {
        const cls = classAt(index)
        let end = index + 1
        while (end < text.length && classAt(end) === cls) end++
        return end
      }
      const runStart = (index: number): number => {
        const cls = classAt(index)
        let start = index
        while (start > 0 && classAt(start - 1) === cls) start--
        return start
      }
      const at = Math.min(text.length - 1, Math.max(0, cursor.column - 1))
      const onBlank = classAt(at) === 'blank'
      const start0 = runStart(at)
      let start = start0
      let end = runEnd(at)
      const extra = steps(count) - 1

      if (!around) {
        for (let i = 0; i < extra && end < text.length; i++) end = runEnd(end)
        return charRange(cursor.line, start + 1, end + 1)
      }

      let trailingBlank = false
      if (onBlank) {
        // Blanks plus the word after them.
        if (end >= text.length) return null
        end = runEnd(end)
      } else if (end < text.length && classAt(end) === 'blank') {
        end = runEnd(end)
        trailingBlank = true
      }
      for (let i = 0; i < extra && end < text.length; i++) {
        end = runEnd(end)
        if (end < text.length && classAt(end) === 'blank') end = runEnd(end)
      }
      // A word at the end of the line takes its leading blanks instead.
      if (!onBlank && !trailingBlank && start0 > 0 && classAt(start0 - 1) === 'blank') {
        start = runStart(start0 - 1)
      }
      return charRange(cursor.line, start + 1, end + 1)
    },
  }
}

// ── quotes ───────────────────────────────────────────────────────────────────

function unescapedQuotePositions(text: string, quote: string): number[] {
  const positions: number[] = []
  for (let index = 0; index < text.length; index++) {
    const ch = text[index]
    if (ch === '\\') {
      index++
      continue
    }
    if (ch === quote) positions.push(index)
  }
  return positions
}

function quoteObject(id: '"' | "'" | '`', name: string): VimTextObjectDef {
  return {
    id,
    keys: [id],
    description: `${name}-quoted string`,
    resolve({ lines, cursor, around, count }) {
      const text = lines.getLineContent(cursor.line)
      const quotes = unescapedQuotePositions(text, id)
      const at = cursor.column - 1
      let openIndex: number
      const onQuote = quotes.indexOf(at)
      if (onQuote >= 0) {
        // Quotes pair up from the start of the line, so parity says which end this is.
        openIndex = onQuote % 2 === 0 ? onQuote : onQuote - 1
      } else {
        // Vim (`:h a"`, current_quote): the nearest quote before the cursor opens the string
        // whatever its parity, so between two strings the text between them is "the string";
        // with no quote before the cursor, the first quote after it opens one.
        const before = quotes.findLastIndex((position) => position < at)
        openIndex = before >= 0 ? before : 0
      }
      const open = quotes[openIndex]
      const close = quotes[openIndex + 1]
      if (open === undefined || close === undefined) return null
      // `2i"` takes the quotes along, like Vim (and it is how a repeated `i"` in Visual climbs out).
      if (!around && count < 2) return charRange(cursor.line, open + 2, close + 1)
      let start = open
      let end = close + 1
      if (around) {
        if (end < text.length && /\s/.test(text[end]!)) {
          while (end < text.length && /\s/.test(text[end]!)) end++
        } else {
          while (start > 0 && /\s/.test(text[start - 1]!)) start--
        }
      }
      return charRange(cursor.line, start + 1, end + 1)
    },
  }
}

// ── brackets ─────────────────────────────────────────────────────────────────

function charAt(lines: VimLineReader, position: VimPosition): string {
  return lines.getLineContent(position.line)[position.column - 1] ?? ''
}

/** The nearest unmatched `open` strictly before `from`. */
function scanBackward(
  lines: VimLineReader,
  from: VimPosition,
  open: string,
  close: string,
): VimPosition | null {
  let depth = 0
  let line = from.line
  let index = from.column - 2
  for (;;) {
    const text = lines.getLineContent(line)
    for (; index >= 0; index--) {
      const ch = text[index]
      if (ch === close) depth++
      else if (ch === open) {
        if (depth === 0) return { line, column: index + 1 }
        depth--
      }
    }
    line--
    if (line < 1) return null
    index = lines.getLineContent(line).length - 1
  }
}

/** The `close` matching an `open` at `from`. */
function scanForward(
  lines: VimLineReader,
  from: VimPosition,
  open: string,
  close: string,
): VimPosition | null {
  const lineCount = lines.getLineCount()
  let depth = 0
  let line = from.line
  let index = from.column
  for (;;) {
    const text = lines.getLineContent(line)
    for (; index < text.length; index++) {
      const ch = text[index]
      if (ch === open) depth++
      else if (ch === close) {
        if (depth === 0) return { line, column: index + 1 }
        depth--
      }
    }
    line++
    if (line > lineCount) return null
    index = 0
  }
}

/** The `count`-th pair of `open`/`close` around the cursor, innermost first. */
function findEnclosingPair(
  lines: VimLineReader,
  cursor: VimPosition,
  open: string,
  close: string,
  count: number,
): { open: VimPosition; close: VimPosition } | null {
  let openPos: VimPosition | null = charAt(lines, cursor) === open ? cursor : null
  if (openPos === null) openPos = scanBackward(lines, cursor, open, close)
  for (let i = 1; i < steps(count) && openPos !== null; i++) {
    openPos = scanBackward(lines, openPos, open, close)
  }
  if (openPos === null) return null
  const closePos = scanForward(lines, openPos, open, close)
  return closePos === null ? null : { open: openPos, close: closePos }
}

function bracketObject(
  id: '(' | '[' | '{' | '<',
  closeKey: string,
  aliases: readonly string[],
  description: string,
): VimTextObjectDef {
  return {
    id,
    keys: [id, closeKey, ...aliases],
    description,
    nests: true,
    resolve({ lines, cursor, around, count }) {
      const pair = findEnclosingPair(lines, cursor, id, closeKey, count)
      if (pair === null) return null
      if (around) {
        return {
          start: pair.open,
          end: { line: pair.close.line, column: pair.close.column + 1 },
          linewise: false,
        }
      }
      return innerBracketRange(lines, pair.open, pair.close)
    },
  }
}

/** Inner range of a bracket pair; a block whose braces sit on their own lines is linewise, like Vim. */
function innerBracketRange(
  lines: VimLineReader,
  open: VimPosition,
  close: VimPosition,
): VimTextObjectRange | null {
  const openAtEol = open.column === lines.getLineContent(open.line).length
  const closeLeading = lines.getLineContent(close.line).slice(0, close.column - 1)
  const closeAtBol = closeLeading.trim() === ''
  const multiLine = close.line > open.line
  if (multiLine && openAtEol && closeAtBol) {
    // `{` and `}` on adjacent lines hold nothing: an empty range at the end of the `{` line.
    if (close.line - open.line < 2) {
      const empty = { line: open.line, column: open.column + 1 }
      return { start: empty, end: empty, linewise: false }
    }
    return {
      start: { line: open.line + 1, column: 1 },
      end: { line: close.line - 1, column: 1 },
      linewise: true,
    }
  }
  const start =
    multiLine && openAtEol
      ? { line: open.line + 1, column: 1 }
      : { line: open.line, column: open.column + 1 }
  const end =
    multiLine && closeAtBol
      ? { line: close.line - 1, column: lines.getLineContent(close.line - 1).length + 1 }
      : close
  return { start, end, linewise: false }
}

// ── paragraphs ───────────────────────────────────────────────────────────────

function paragraphObject(): VimTextObjectDef {
  return {
    id: 'p',
    keys: ['p'],
    description: 'paragraph',
    resolve({ lines, cursor, around, count }) {
      const lineCount = lines.getLineCount()
      const blankAt = (line: number) => isBlankLine(lines, line)
      const runEnd = (line: number): number => {
        const blank = blankAt(line)
        let end = line
        while (end < lineCount && blankAt(end + 1) === blank) end++
        return end
      }
      const runStart = (line: number): number => {
        const blank = blankAt(line)
        let start = line
        while (start > 1 && blankAt(start - 1) === blank) start--
        return start
      }
      let start = runStart(cursor.line)
      let end = runEnd(cursor.line)
      const startsOnBlank = blankAt(cursor.line)
      let remaining = steps(count)
      if (!around) {
        while (--remaining > 0 && end < lineCount) end = runEnd(end + 1)
      } else {
        // Paragraph + the blank run after it (or blank run + the paragraph after it).
        let hadTrailing = true
        const takeNext = (): boolean => {
          if (end >= lineCount) return false
          end = runEnd(end + 1)
          return true
        }
        if (!takeNext()) hadTrailing = false
        while (--remaining > 0) {
          if (!takeNext()) break
          takeNext()
        }
        // A last paragraph with nothing after it takes the blank lines before it.
        if (!hadTrailing && !startsOnBlank && start > 1) start = runStart(start - 1)
      }
      return {
        start: { line: start, column: 1 },
        end: { line: end, column: 1 },
        linewise: true,
      }
    },
  }
}

// ── tags ─────────────────────────────────────────────────────────────────────

const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
])
/** Lines scanned on each side of the cursor; a tag block larger than this is out of reach. */
const TAG_SCAN_RADIUS = 3000
/**
 * An opening / closing / self-closing tag. Attribute values may hold `>` inside quotes
 * (`title="a>b"`) and arrows (`onClick={() => go()}`), which must not end the tag.
 */
const TAG_RE = /<(\/?)([A-Za-z][^\s/>]*)((?:"[^"]*"|'[^']*'|=>|[^<>"'])*?)(\/?)>/g

interface TagPair {
  readonly openStart: VimPosition
  readonly openEnd: VimPosition
  readonly closeStart: VimPosition
  readonly closeEnd: VimPosition
}

/**
 * Tag pairs in a window around `cursor`, innermost-enclosing first. Pairs close
 * innermost-first, so the scan stops as soon as `count` pairs around the cursor are known.
 */
function collectEnclosingTagPairs(
  lines: VimLineReader,
  cursor: VimPosition,
  count: number,
): TagPair[] {
  const pairs: TagPair[] = []
  const stack: { name: string; start: VimPosition; end: VimPosition }[] = []
  const firstLine = Math.max(1, cursor.line - TAG_SCAN_RADIUS)
  const lastLine = Math.min(lines.getLineCount(), cursor.line + TAG_SCAN_RADIUS)
  for (let line = firstLine; line <= lastLine; line++) {
    const text = lines.getLineContent(line)
    for (const match of text.matchAll(TAG_RE)) {
      const name = match[2]!.toLowerCase()
      const start = { line, column: match.index! + 1 }
      const end = { line, column: match.index! + match[0].length + 1 }
      if (match[1] === '/') {
        let depth = stack.length - 1
        while (depth >= 0 && stack[depth]!.name !== name) depth--
        if (depth < 0) continue
        const opened = stack[depth]!
        stack.length = depth
        if (comparePositions(opened.start, cursor) <= 0 && comparePositions(cursor, end) < 0) {
          pairs.push({
            openStart: opened.start,
            openEnd: opened.end,
            closeStart: start,
            closeEnd: end,
          })
        }
      } else if (match[4] !== '/' && !VOID_TAGS.has(name)) {
        stack.push({ name, start, end })
      }
    }
    if (line >= cursor.line && pairs.length >= count) break
  }
  return pairs
}

function tagObject(): VimTextObjectDef {
  return {
    id: 't',
    keys: ['t'],
    description: 'HTML/XML tag block',
    nests: true,
    resolve({ lines, cursor, around, count }) {
      // Nested pairs close innermost-first, so the `count`-th one found is the one wanted.
      const pair = collectEnclosingTagPairs(lines, cursor, steps(count))[steps(count) - 1]
      if (pair === undefined) return null
      return around
        ? { start: pair.openStart, end: pair.closeEnd, linewise: false }
        : { start: pair.openEnd, end: pair.closeStart, linewise: false }
    },
  }
}

/** Every text object an operator or Visual selection can take. One entry per object. */
export const VIM_TEXT_OBJECTS: readonly VimTextObjectDef[] = [
  wordObject('w'),
  wordObject('W'),
  quoteObject('"', 'double'),
  quoteObject("'", 'single'),
  quoteObject('`', 'backtick'),
  bracketObject('(', ')', ['b'], 'parenthesis block'),
  bracketObject('[', ']', [], 'square-bracket block'),
  bracketObject('{', '}', ['B'], 'curly-brace block'),
  bracketObject('<', '>', [], 'angle-bracket block'),
  paragraphObject(),
  tagObject(),
]

const OBJECTS_BY_ID = new Map<VimTextObjectId, VimTextObjectDef>(
  VIM_TEXT_OBJECTS.map((def) => [def.id, def]),
)
const OBJECTS_BY_KEY = new Map<string, VimTextObjectDef>(
  VIM_TEXT_OBJECTS.flatMap((def) => def.keys.map((key) => [key, def] as const)),
)

export function getVimTextObject(id: VimTextObjectId): VimTextObjectDef {
  const def = OBJECTS_BY_ID.get(id)
  if (def === undefined) throw new Error(`[vim] text object "${id}" is not registered`)
  return def
}

/** The text object a key after `i` / `a` selects. */
export function findVimTextObjectByKey(key: string): VimTextObjectDef | undefined {
  return OBJECTS_BY_KEY.get(key)
}

// ── Visual mode ──────────────────────────────────────────────────────────────

/** Most enclosing levels a repeated `i(` / `it` climbs while looking for a bigger one. */
const MAX_VISUAL_CLIMB = 32

export interface VimVisualTextObjectInput {
  readonly lines: VimLineReader
  readonly selection: VimVisualSelection
  readonly object: VimTextObjectId
  readonly around: boolean
  readonly count: number
}

/** The position `step` characters/lines away from `from`, or null at the buffer edge. */
function neighbour(
  lines: VimLineReader,
  from: VimPosition,
  direction: 1 | -1,
  wholeLines: boolean,
): VimPosition | null {
  if (wholeLines) {
    const line = from.line + direction
    return line < 1 || line > lines.getLineCount() ? null : { line, column: 1 }
  }
  const length = lines.getLineContent(from.line).length
  if (direction === 1) {
    if (from.column < length) return { line: from.line, column: from.column + 1 }
    return from.line < lines.getLineCount() ? { line: from.line + 1, column: 1 } : null
  }
  if (from.column > 1) return { line: from.line, column: from.column - 1 }
  if (from.line === 1) return null
  const previous = from.line - 1
  return { line: previous, column: Math.max(1, lines.getLineContent(previous).length) }
}

/** Last selected character of a charwise object range (its `end` is exclusive), or null if empty. */
function lastCharacterOf(lines: VimLineReader, range: VimTextObjectRange): VimPosition | null {
  let last: VimPosition = { line: range.end.line, column: range.end.column - 1 }
  // An end in column 1 belongs to the line before.
  if (range.end.column <= 1 && range.end.line > range.start.line) {
    const previous = range.end.line - 1
    last = { line: previous, column: Math.max(1, lines.getLineContent(previous).length) }
  }
  return comparePositions(last, range.start) < 0 ? null : last
}

function isBiggerThan(
  lines: VimLineReader,
  range: VimTextObjectRange,
  lo: VimPosition,
  hi: VimPosition,
): boolean {
  if (range.linewise) return range.start.line < lo.line || range.end.line > hi.line
  const last = lastCharacterOf(lines, range)
  return last !== null && (comparePositions(range.start, lo) < 0 || comparePositions(last, hi) > 0)
}

/**
 * `iw` / `a(` / … typed in Visual mode. With no selection yet it selects the object; with
 * one it grows it, as Vim does:
 * - words and paragraphs extend to the next one in the direction the cursor leads (a
 *   backward selection grows backward);
 * - nesting objects (brackets, tags) and quotes climb to the next enclosing object once the
 *   selection already covers the current one (`vi(` then `i(`).
 * A charwise object turns `V` / Ctrl+V into plain `v`. Returns null when nothing can grow.
 */
export function extendVisualByTextObject(
  input: VimVisualTextObjectInput,
): VimVisualSelection | null {
  const { lines, selection, object, around } = input
  const count = steps(input.count)
  const def = getVimTextObject(object)
  const { anchor, cursor } = selection
  const trivial = comparePositions(anchor, cursor) === 0
  const backward = comparePositions(cursor, anchor) < 0
  const [lo, hi] = backward ? [cursor, anchor] : [anchor, cursor]

  let range: VimTextObjectRange | null
  if (trivial) {
    range = def.resolve({ lines, cursor, around, count })
  } else if (object === 'w' || object === 'W' || object === 'p') {
    const origin = neighbour(lines, backward ? lo : hi, backward ? -1 : 1, object === 'p')
    range = origin === null ? null : def.resolve({ lines, cursor: origin, around, count })
  } else {
    range = null
    for (let extra = 0; extra < MAX_VISUAL_CLIMB; extra++) {
      const candidate = def.resolve({ lines, cursor: lo, around, count: count + extra })
      if (candidate === null) break
      if (isBiggerThan(lines, candidate, lo, hi)) {
        range = candidate
        break
      }
    }
  }
  if (range === null) return null

  if (range.linewise) {
    const first = trivial ? range.start.line : Math.min(lo.line, range.start.line)
    const last = trivial ? range.end.line : Math.max(hi.line, range.end.line)
    return backward
      ? {
          mode: 'visual-line',
          anchor: { line: last, column: 1 },
          cursor: { line: first, column: 1 },
        }
      : {
          mode: 'visual-line',
          anchor: { line: first, column: 1 },
          cursor: { line: last, column: 1 },
        }
  }
  const last = lastCharacterOf(lines, range)
  if (last === null) return null
  const start = trivial || comparePositions(range.start, lo) < 0 ? range.start : lo
  const end = trivial || comparePositions(last, hi) > 0 ? clampNormalPosition(lines, last) : hi
  return backward
    ? { mode: 'visual', anchor: end, cursor: start }
    : { mode: 'visual', anchor: start, cursor: end }
}
