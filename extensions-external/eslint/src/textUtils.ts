/**
 * Offset ⇄ LSP position helpers. ESLint reports fixes as character offsets into
 * the source string; LSP/Monaco want 0-based line + character. Kept pure and
 * standalone so they're unit-testable without a running server.
 */
import type { Position, Range } from 'vscode-languageserver-types'

/** Precomputed line-start offsets for O(log n) offset→position over one text. */
export class LineIndex {
  private readonly _lineStarts: number[]

  constructor(private readonly _text: string) {
    const starts = [0]
    for (let i = 0; i < _text.length; i++) {
      if (_text.charCodeAt(i) === 10 /* \n */) starts.push(i + 1)
    }
    this._lineStarts = starts
  }

  get text(): string {
    return this._text
  }

  /** Character offset → 0-based {line, character}. Clamped to the text length. */
  positionAt(offset: number): Position {
    const off = Math.max(0, Math.min(offset, this._text.length))
    // Binary search for the last line start <= off.
    let lo = 0
    let hi = this._lineStarts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if ((this._lineStarts[mid] as number) <= off) lo = mid
      else hi = mid - 1
    }
    return { line: lo, character: off - (this._lineStarts[lo] as number) }
  }

  /** A range from a start/end character offset pair. */
  rangeAt(start: number, end: number): Range {
    return { start: this.positionAt(start), end: this.positionAt(end) }
  }

  /** A range covering the entire document. */
  fullRange(): Range {
    return { start: { line: 0, character: 0 }, end: this.positionAt(this._text.length) }
  }
}
