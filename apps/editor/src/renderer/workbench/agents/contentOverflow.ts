/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  contentOverflow — first-paint height stability for clamped timeline leaves
 *  (UserMessageItem body, TerminalOutput). In the virtualized timeline a row is
 *  remounted every time it scrolls back into the overscan window; if a leaf
 *  renders tall on mount and clamps short afterwards, the virtualizer records a
 *  different height per (re)mount and its size-change compensation oscillates
 *  scrollTop forever (the scroll-jitter limit cycle). Two tools break that:
 *   - a synchronous, CJK-width-aware estimate so the FIRST paint already renders
 *     at the final (clamped) height;
 *   - a measured-overflow cache keyed by contentKey, so any row measured once
 *     remounts at its real state even where the estimate is off (images, fonts).
 *--------------------------------------------------------------------------------------------*/

import type { ContentBlock } from '@agentclientprotocol/sdk'

// Rendered height caps — must match agents.module.css (.terminalOutput /
// .userMessageBody [data-collapsed] max-height).
export const TERMINAL_COLLAPSED_MAX_PX = 240
export const USER_MESSAGE_COLLAPSED_MAX_PX = 160

const TERMINAL_LINE_PX = 16
const TERMINAL_WRAP_COLS = 80
const TERMINAL_VPAD_PX = 8

const USER_LINE_PX = 21
const USER_WRAP_COLS = 90

// East-Asian wide / fullwidth code points render at roughly double the width of
// a latin cell in both monospace (wcwidth semantics) and proportional fonts.
// Estimating wrap by raw character count halves the line count for CJK text —
// "estimate says fits, DOM says clamp" — which is exactly the per-mount height
// flip that feeds the jitter loop. Coarse range table, not full Unicode EAW.
function isWideCharCode(cp: number): boolean {
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals … CJK punctuation
    (cp >= 0x3041 && cp <= 0x33ff) || // kana, Hangul compat jamo, CJK compat
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK unified
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compat ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK compat forms
    (cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) || // fullwidth signs
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK ext B+
  )
}

// Display width of one line in character cells (CJK-aware), capped so a single
// huge line (base64 blob, minified JSON) stops counting once the answer is
// decided.
function displayColsCapped(line: string, cap: number): number {
  let cols = 0
  for (let i = 0; i < line.length; i++) {
    const cp = line.codePointAt(i)!
    if (cp > 0xffff) i++
    cols += isWideCharCode(cp) ? 2 : 1
    if (cols >= cap) return cols
  }
  return cols
}

/**
 * Estimate how many wrapped lines `text` renders as, stopping early once
 * `maxLines` is reached (overflow checks only need "at least N", and rows are
 * height-capped anyway, so exact counts past the cap are wasted work).
 */
export function estimateWrappedLinesUpTo(text: string, wrapCols: number, maxLines: number): number {
  let lines = 0
  for (const seg of text.split('\n')) {
    const cols = displayColsCapped(seg, wrapCols * (maxLines - lines + 1))
    lines += Math.max(1, Math.ceil(cols / wrapCols))
    if (lines >= maxLines) return lines
  }
  return Math.max(1, lines)
}

const TERMINAL_MAX_LINES = Math.ceil(
  (TERMINAL_COLLAPSED_MAX_PX - TERMINAL_VPAD_PX) / TERMINAL_LINE_PX,
)

/**
 * Synchronous first-render estimate of whether a terminal body exceeds the
 * collapsed cap, from the text alone (no DOM measurement) — the committed
 * height must be identical on every mount or the correction loop returns.
 */
export function estimateTerminalOverflow(text: string): boolean {
  const lines = estimateWrappedLinesUpTo(text, TERMINAL_WRAP_COLS, TERMINAL_MAX_LINES + 1)
  return lines * TERMINAL_LINE_PX + TERMINAL_VPAD_PX > TERMINAL_COLLAPSED_MAX_PX
}

const USER_MAX_LINES = Math.ceil(USER_MESSAGE_COLLAPSED_MAX_PX / USER_LINE_PX)

/**
 * Same idea for a user message body (markdown blocks clamped to 160px). Images
 * decode asynchronously with unknowable height — treat them as overflowing so
 * the first paint clamps; the measured cache corrects the rare small-image case
 * once and keeps it stable from then on.
 */
export function estimateUserMessageOverflow(
  blocks: readonly ContentBlock[],
  leadingLines = 0,
): boolean {
  let lines = leadingLines
  for (const block of blocks) {
    if (block.type === 'image') return true
    if (block.type === 'text') {
      lines += estimateWrappedLinesUpTo(block.text, USER_WRAP_COLS, USER_MAX_LINES + 1)
    } else {
      lines += 1
    }
    if (lines > USER_MAX_LINES) return true
  }
  return lines * USER_LINE_PX > USER_MESSAGE_COLLAPSED_MAX_PX
}

// contentKey → the overflow state last measured from the real DOM. Remounts
// seed from this so a row whose estimate was wrong flips once (on the mount
// that measured it), not on every remount. Insertion-ordered eviction keeps it
// bounded; keys are slot-key based and globally unique across sessions.
const measuredOverflow = new Map<string, boolean>()
const MEASURED_OVERFLOW_CAP = 2000

export function rememberMeasuredOverflow(contentKey: string | undefined, value: boolean): void {
  if (contentKey === undefined) return
  if (!measuredOverflow.has(contentKey) && measuredOverflow.size >= MEASURED_OVERFLOW_CAP) {
    const oldest = measuredOverflow.keys().next().value
    if (oldest !== undefined) measuredOverflow.delete(oldest)
  }
  measuredOverflow.set(contentKey, value)
}

export function recallMeasuredOverflow(contentKey: string | undefined): boolean | undefined {
  return contentKey === undefined ? undefined : measuredOverflow.get(contentKey)
}

/**
 * The overflow state a clamped leaf must mount with. Prefers the measured
 * truth from a previous mount; the estimate still wins when it says "overflows"
 * and the cache says not — content only ever grows (streaming appends), so
 * overflow is monotonic and the stale-cache direction that matters is false→true.
 */
export function initialOverflow(contentKey: string | undefined, estimate: () => boolean): boolean {
  const measured = recallMeasuredOverflow(contentKey)
  return measured === undefined ? estimate() : measured || estimate()
}

export function _resetMeasuredOverflowForTests(): void {
  measuredOverflow.clear()
}
