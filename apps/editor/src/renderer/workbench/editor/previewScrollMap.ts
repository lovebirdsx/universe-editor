/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Pure helpers mapping markdown source line numbers to/from pixel offsets in a
 *  rendered preview. The preview's block elements carry their source line as a
 *  `data-line` attribute; given those control points we interpolate piecewise-
 *  linearly. Shared by the source↔preview scroll sync and the Outline view's
 *  reveal/active-symbol tracking, neither of which depends on Monaco here.
 *--------------------------------------------------------------------------------------------*/

export interface Point {
  readonly key: number
  readonly value: number
}

/**
 * Piecewise-linear map: given (key→value) control points, return the value at
 * `probe`, clamping to the endpoints outside the mapped range.
 */
export function interpolate(points: readonly Point[], probe: number): number {
  if (points.length === 0) return 0
  const sorted = [...points].sort((a, b) => a.key - b.key)
  const first = sorted[0]!
  const last = sorted[sorted.length - 1]!
  if (probe <= first.key) return first.value
  if (probe >= last.key) return last.value
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]!
    const b = sorted[i + 1]!
    if (probe >= a.key && probe <= b.key) {
      const span = b.key - a.key
      const frac = span > 0 ? (probe - a.key) / span : 0
      return a.value + frac * (b.value - a.value)
    }
  }
  return last.value
}

export interface LineEntry {
  readonly line: number
  readonly top: number
}

/** Collect every `data-line` block's source line (1-based) and pixel top within `root`. */
export function collectEntries(root: HTMLElement): LineEntry[] {
  const rootRect = root.getBoundingClientRect()
  const out: LineEntry[] = []
  for (const el of root.querySelectorAll<HTMLElement>('[data-line]')) {
    // `data-line` is the 0-based source line (= monaco lineNumber - 1); store it
    // 1-based so it lines up with DocumentSymbol ranges and editor line numbers.
    const raw = Number(el.dataset['line'])
    if (Number.isNaN(raw)) continue
    out.push({ line: raw + 1, top: el.getBoundingClientRect().top - rootRect.top + root.scrollTop })
  }
  return out
}

/** Pixel scrollTop that brings `line` (1-based) to the top of the preview. */
export function previewTopForLine(entries: readonly LineEntry[], line: number): number {
  return interpolate(
    entries.map((e) => ({ key: e.line, value: e.top })),
    line,
  )
}

/** Source line (1-based) currently at the top of the preview viewport. */
export function lineForPreviewTop(entries: readonly LineEntry[], scrollTop: number): number {
  return Math.round(
    interpolate(
      entries.map((e) => ({ key: e.top, value: e.line })),
      scrollTop,
    ),
  )
}

/**
 * Pixel scrollTop that brings a source line to the *top* of a Monaco editor,
 * clamped so it never scrolls past the useful content. `lineTop` is the line's
 * pixel offset; `contentBottom` is the bottom of the last line (content height
 * *excluding* Monaco's scroll-beyond-last-line padding); `viewportHeight` is the
 * editor's layout height. Clamping to `contentBottom - viewportHeight` makes a
 * near-the-end reveal land the last line flush at the bottom rather than leaving
 * a viewport of blank padding below it.
 */
export function clampRevealScrollTop(params: {
  lineTop: number
  contentBottom: number
  viewportHeight: number
}): number {
  const maxUseful = Math.max(0, params.contentBottom - params.viewportHeight)
  return Math.max(0, Math.min(params.lineTop, maxUseful))
}
