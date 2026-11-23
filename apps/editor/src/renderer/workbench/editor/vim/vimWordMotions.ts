/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Word motions (`w`/`b`/`e`, big-word variants) ported from Vim's `fwd_word` /
 *  `bck_word` / `end_word`. They walk a cursor one character at a time over a
 *  lazy line reader, so only the lines actually crossed are ever read — never the
 *  whole buffer. Like Vim, the cursor may rest on the end-of-line position
 *  (`col === line length`) mid-walk, which classifies as blank, and an empty line
 *  counts as a word for `w` and `b` (but `e` skips it).
 *
 *  Columns here are 0-based UTF-16 offsets; callers convert to Monaco's 1-based.
 *--------------------------------------------------------------------------------------------*/

import type { VimLineReader } from './vimTypes.js'

export type VimCharClass = 'blank' | 'keyword' | 'punct'

export function classifyChar(ch: string): VimCharClass {
  if (ch === '' || /\s/.test(ch)) return 'blank'
  return /[\p{L}\p{N}_]/u.test(ch) ? 'keyword' : 'punct'
}

/** Class of the character starting at `col`; the end-of-line slot is blank. */
export function charClassAt(text: string, col: number, bigWord: boolean): VimCharClass {
  if (col < 0 || col >= text.length) return 'blank'
  const ch = String.fromCodePoint(text.codePointAt(col)!)
  if (bigWord) return /\s/.test(ch) ? 'blank' : 'keyword'
  return classifyChar(ch)
}

/** A position inside a line; `col` may equal the line length (the end-of-line slot). */
export interface VimWordPos {
  readonly line: number
  readonly col: number
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

/** Result of `inc()`: -1 end of buffer, 0 same line, 1 crossed a line, 2 landed on end-of-line. */
type IncResult = -1 | 0 | 1 | 2

class WordCursor {
  line: number
  col: number
  private text: string

  constructor(
    private readonly reader: VimLineReader,
    private readonly bigWord: boolean,
    start: VimWordPos,
  ) {
    this.line = start.line
    this.text = reader.getLineContent(start.line)
    this.col = Math.max(0, Math.min(this.text.length, start.col))
  }

  get lineIsLast(): boolean {
    return this.line >= this.reader.getLineCount()
  }

  /** Cursor sits on an empty line (the only place an empty line is a "word"). */
  get onEmptyLine(): boolean {
    return this.col === 0 && this.text.length === 0
  }

  cls(): VimCharClass {
    return charClassAt(this.text, this.col, this.bigWord)
  }

  inc(): IncResult {
    if (this.col < this.text.length) {
      this.col += isHighSurrogate(this.text.charCodeAt(this.col)) ? 2 : 1
      this.col = Math.min(this.col, this.text.length)
      return this.col < this.text.length ? 0 : 2
    }
    if (this.line < this.reader.getLineCount()) {
      this.line++
      this.col = 0
      this.text = this.reader.getLineContent(this.line)
      return 1
    }
    return -1
  }

  dec(): -1 | 0 | 1 {
    if (this.col > 0) {
      this.col -=
        this.col >= 2 &&
        isLowSurrogate(this.text.charCodeAt(this.col - 1)) &&
        isHighSurrogate(this.text.charCodeAt(this.col - 2))
          ? 2
          : 1
      return 0
    }
    if (this.line > 1) {
      this.line--
      this.text = this.reader.getLineContent(this.line)
      this.col = this.text.length
      return 1
    }
    return -1
  }

  /** Advance while the class matches; true when the buffer ended first. */
  skipForward(cclass: VimCharClass): boolean {
    while (this.cls() === cclass) if (this.inc() === -1) return true
    return false
  }

  skipBackward(cclass: VimCharClass): boolean {
    while (this.cls() === cclass) if (this.dec() === -1) return true
    return false
  }

  pos(): VimWordPos {
    return { line: this.line, col: this.col }
  }
}

/**
 * `w` / `W`. With `stopAtLineEnd` (an operator is pending) the final jump stops
 * on the end-of-line slot instead of crossing into the next line, so `dw` on the
 * last word of a line leaves the line break alone. May return the end-of-line
 * slot; callers clamp for plain cursor movement.
 */
export function wordForward(
  reader: VimLineReader,
  start: VimWordPos,
  count: number,
  bigWord: boolean,
  stopAtLineEnd: boolean,
): VimWordPos {
  const cursor = new WordCursor(reader, bigWord, start)
  for (let remaining = Math.max(1, count) - 1; remaining >= 0; remaining--) {
    const startClass = cursor.cls()
    const lastLine = cursor.lineIsLast
    let step = cursor.inc()
    if (step === -1 || (step >= 1 && lastLine)) return cursor.pos()
    if (step >= 1 && stopAtLineEnd && remaining === 0) return cursor.pos()

    if (startClass !== 'blank') {
      while (cursor.cls() === startClass) {
        step = cursor.inc()
        if (step === -1 || (step >= 1 && stopAtLineEnd && remaining === 0)) return cursor.pos()
      }
    }
    while (cursor.cls() === 'blank') {
      // An empty line is a word of its own.
      if (cursor.onEmptyLine) break
      step = cursor.inc()
      if (step === -1 || (step >= 1 && lastLine)) return cursor.pos()
    }
  }
  return cursor.pos()
}

/**
 * `b` / `B`. An empty line stops the walk, like a word start.
 */
export function wordBackward(
  reader: VimLineReader,
  start: VimWordPos,
  count: number,
  bigWord: boolean,
): VimWordPos {
  const cursor = new WordCursor(reader, bigWord, start)
  for (let remaining = Math.max(1, count); remaining > 0; remaining--) {
    if (cursor.dec() === -1) return cursor.pos()
    let reachedEmptyLine = false
    while (cursor.cls() === 'blank') {
      if (cursor.onEmptyLine) {
        reachedEmptyLine = true
        break
      }
      if (cursor.dec() === -1) return cursor.pos()
    }
    if (reachedEmptyLine) continue
    if (cursor.skipBackward(cursor.cls())) return cursor.pos()
    cursor.inc()
  }
  return cursor.pos()
}

/**
 * `e` / `E`. `stayOnWordEnd` makes the first jump count the word the cursor is
 * already finishing — Vim's `cw`, which changes the rest of the current word
 * instead of skipping to the next one.
 */
export function wordEnd(
  reader: VimLineReader,
  start: VimWordPos,
  count: number,
  bigWord: boolean,
  stayOnWordEnd = false,
): VimWordPos {
  const cursor = new WordCursor(reader, bigWord, start)
  let stop = stayOnWordEnd
  for (let remaining = Math.max(1, count); remaining > 0; remaining--) {
    const startClass = cursor.cls()
    if (cursor.inc() === -1) return cursor.pos()
    if (cursor.cls() === startClass && startClass !== 'blank') {
      if (cursor.skipForward(startClass)) return cursor.pos()
    } else if (!stop || startClass === 'blank') {
      // Past the end of a word: skip blanks (empty lines included), then run to
      // the end of the next word.
      while (cursor.cls() === 'blank') if (cursor.inc() === -1) return cursor.pos()
      if (cursor.skipForward(cursor.cls())) return cursor.pos()
    }
    // Overshot by one.
    cursor.dec()
    stop = false
  }
  return cursor.pos()
}
