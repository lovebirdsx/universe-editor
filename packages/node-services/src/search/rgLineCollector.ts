/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Line collector for a ripgrep stdout stream: joins decoded chunks into complete
 *  lines, filters them through an optional accept callback and stops at a cap
 *  counted against *accepted* lines. Kept as a standalone unit so the shapes a
 *  real rg never emits here — an unterminated final line, a chunk boundary
 *  landing inside one — stay deterministic under test.
 *--------------------------------------------------------------------------------------------*/

import { normalizeRel } from './ripgrepUtil.js'

export class RgLineCollector {
  private readonly _lines: string[] = []
  private _remainder = ''
  private _scanned = 0
  private _capped = false

  constructor(
    private readonly _cap: number,
    /** Filters complete lines; called with the `normalizeRel` form of the line. */
    private readonly _accept?: (relPath: string) => boolean,
  ) {
    // 「不要任何结果」（cap <= 0）当场短路：一条都不进 accept、不计 scanned，也不等
    // 第一个分块才靠 `lines.length >= cap` 偶然停下。
    this._capped = _cap <= 0
  }

  /** Complete lines kept so far (raw, pre-normalization). */
  get lines(): readonly string[] {
    return this._lines
  }

  /** Complete lines seen so far, accepted or filtered out — the "walked" count. */
  get scanned(): number {
    return this._scanned
  }

  get capped(): boolean {
    return this._capped
  }

  push(chunk: string): void {
    if (this._capped) return
    const data = this._remainder + chunk
    const parts = data.split(/\r?\n/)
    this._remainder = parts.pop() ?? ''
    for (const part of parts) {
      this._pushLine(part)
      if (this._capped) {
        this._remainder = ''
        return
      }
    }
  }

  /**
   * Stream ended: absorb `chunk` (the decoder's flush) and treat the
   * unterminated tail as a complete line — same accept/cap path as any other.
   */
  end(chunk: string): void {
    if (this._capped) {
      this._remainder = ''
      return
    }
    this.push(chunk)
    if (this._capped) return
    const tail = this._remainder
    this._remainder = ''
    if (tail.length > 0) this._pushLine(tail)
  }

  private _pushLine(part: string): void {
    if (part.length === 0) return
    this._scanned++
    if (this._accept !== undefined && !this._accept(normalizeRel(part))) return
    this._lines.push(part)
    if (this._lines.length >= this._cap) this._capped = true
  }
}
