/**
 * Toggle a symmetric inline delimiter (`**`, `*`, `` ` ``, `~~`, `$`) around the
 * selection. With a selection: wrap it, or unwrap when it (or its immediate
 * surroundings) already carry the delimiter. With an empty selection: toggle the
 * enclosing delimiter pair, toggle the word under the cursor, or insert an
 * empty pair and place the cursor inside.
 *
 * Single-line only — the common case for inline emphasis; a multi-line selection
 * wraps the whole span as-is (matching MAIO, which leaves block decisions to the
 * user).
 */
import {
  cursor,
  isEmpty,
  ordered,
  range,
  selection,
  type EditResult,
  type Selection,
} from './textEditing.js'

interface WordRange {
  start: number
  end: number
}

interface DelimitedRange {
  openStart: number
  contentStart: number
  contentEnd: number
  closeEnd: number
}

const WORD_RE = /[\p{L}\p{N}_]+/u

/** Find the word covering or adjacent to `character` on `line`. */
function wordAt(line: string, character: number): WordRange | undefined {
  const re = /[\p{L}\p{N}_]+/gu
  let m: RegExpExecArray | null
  while ((m = re.exec(line)) !== null) {
    const start = m.index
    const end = m.index + m[0].length
    if (character >= start && character <= end) return { start, end }
    if (start > character) break
  }
  return undefined
}

function hasSurrounding(line: string, start: number, end: number, delim: string): boolean {
  return (
    start >= delim.length &&
    end + delim.length <= line.length &&
    line.slice(start - delim.length, start) === delim &&
    line.slice(end, end + delim.length) === delim
  )
}

function isWrappedInside(text: string, delim: string): boolean {
  return (
    text.length >= delim.length * 2 &&
    text.startsWith(delim) &&
    text.endsWith(delim) &&
    text.slice(delim.length, text.length - delim.length).length >= 0
  )
}

function enclosingDelimitedRange(
  line: string,
  character: number,
  delim: string,
): DelimitedRange | undefined {
  const d = delim.length
  // CommonMark flanking, the part that matters here: a delimiter run only opens
  // emphasis when a non-space follows it, and only closes when a non-space
  // precedes it. This keeps a leading list bullet (`* `) — or any `*` hugging a
  // space — from being mis-paired with a real emphasis delimiter.
  const isSpace = (c: string | undefined) => c === undefined || c === ' ' || c === '\t'
  const canOpen = (i: number) => !isSpace(line[i + d])
  const canClose = (i: number) => !isSpace(line[i - 1])

  let openStart: number | undefined

  for (let i = 0; i <= line.length - d; ) {
    if (line.slice(i, i + d) !== delim) {
      i++
      continue
    }

    if (openStart === undefined) {
      if (canOpen(i)) openStart = i
    } else if (canClose(i)) {
      const contentStart = openStart + d
      const contentEnd = i
      if (character >= contentStart && character <= contentEnd) {
        return { openStart, contentStart, contentEnd, closeEnd: i + d }
      }
      openStart = undefined
    } else if (canOpen(i)) {
      openStart = i
    }

    i += d
  }

  return undefined
}

function unwrapDelimitedRange(
  line: string,
  lineNumber: number,
  wrapped: DelimitedRange,
): EditResult {
  const inner = line.slice(wrapped.contentStart, wrapped.contentEnd)
  return {
    edits: [
      { range: range(lineNumber, wrapped.openStart, lineNumber, wrapped.closeEnd), text: inner },
    ],
  }
}

/** Compute the toggle for one selection on its line. */
function toggleOne(line: string, sel: Selection, delim: string): EditResult {
  const d = delim.length

  if (!isEmpty(sel)) {
    const { start, end } = ordered(sel)
    // Multi-line selection: wrap verbatim, no unwrap detection.
    if (start.line !== end.line) {
      return {
        edits: [
          { range: range(end.line, end.character, end.line, end.character), text: delim },
          { range: range(start.line, start.character, start.line, start.character), text: delim },
        ],
      }
    }
    const s = start.character
    const e = end.character
    const inner = line.slice(s, e)
    const wrapped = enclosingDelimitedRange(line, s, delim)
    if (wrapped && e >= wrapped.contentStart && e <= wrapped.contentEnd) {
      const unwrapped = unwrapDelimitedRange(line, start.line, wrapped)
      return {
        ...unwrapped,
        selections: [
          selection(
            {
              line: start.line,
              character: Math.max(wrapped.openStart, s - d),
            },
            {
              line: start.line,
              character: Math.max(wrapped.openStart, e - d),
            },
          ),
        ],
      }
    }

    // Selection already includes the delimiters → strip them.
    if (isWrappedInside(inner, delim)) {
      const stripped = inner.slice(d, inner.length - d)
      return {
        edits: [{ range: range(start.line, s, end.line, e), text: stripped }],
        selections: [
          selection(
            { line: start.line, character: s },
            { line: start.line, character: s + stripped.length },
          ),
        ],
      }
    }
    // Delimiters sit just outside the selection → strip them too.
    if (hasSurrounding(line, s, e, delim)) {
      return {
        edits: [{ range: range(start.line, s - d, end.line, e + d), text: inner }],
        selections: [
          selection(
            { line: start.line, character: s - d },
            { line: start.line, character: s - d + inner.length },
          ),
        ],
      }
    }
    // Otherwise wrap.
    return {
      edits: [
        { range: range(end.line, e, end.line, e), text: delim },
        { range: range(start.line, s, start.line, s), text: delim },
      ],
      selections: [
        selection({ line: start.line, character: s + d }, { line: start.line, character: e + d }),
      ],
    }
  }

  // Empty selection: unwrap an enclosing span before falling back to the word.
  const { line: ln, character: ch } = sel.active
  const wrapped = enclosingDelimitedRange(line, ch, delim)
  if (wrapped) {
    const unwrapped = unwrapDelimitedRange(line, ln, wrapped)
    return {
      ...unwrapped,
      selections: [
        cursor(
          ln,
          Math.max(
            wrapped.openStart,
            Math.min(ch - d, wrapped.openStart + wrapped.contentEnd - wrapped.contentStart),
          ),
        ),
      ],
    }
  }

  const word = wordAt(line, ch)
  if (word && WORD_RE.test(line.slice(word.start, word.end))) {
    if (hasSurrounding(line, word.start, word.end, delim)) {
      const inner = line.slice(word.start, word.end)
      return {
        edits: [{ range: range(ln, word.start - d, ln, word.end + d), text: inner }],
        selections: [cursor(ln, Math.max(word.start - d, Math.min(ch - d, word.end - d)))],
      }
    }
    return {
      edits: [
        { range: range(ln, word.end, ln, word.end), text: delim },
        { range: range(ln, word.start, ln, word.start), text: delim },
      ],
      selections: [cursor(ln, ch + d)],
    }
  }

  // No word: insert an empty pair, cursor between the delimiters.
  return {
    edits: [{ range: range(ln, ch, ln, ch), text: delim + delim }],
    selections: [cursor(ln, ch + d)],
  }
}

/**
 * Compute the toggle for the primary selection. Multi-cursor falls back to the
 * primary one — emphasis with many cursors is rare and the per-line offset
 * bookkeeping isn't worth it here.
 */
export function toggleDelimiter(
  lines: readonly string[],
  selections: readonly Selection[],
  delim: string,
): EditResult | undefined {
  const sel = selections[0]
  if (!sel) return undefined
  const line = lines[sel.active.line] ?? ''
  return toggleOne(line, sel, delim)
}
