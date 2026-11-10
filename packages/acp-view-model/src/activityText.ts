/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Shared activity-text helpers: single-line summaries, code-fence stripping and
 *  elapsed-time formatting used by the desktop activity hint and the phone's
 *  hidden-activity row. Pure / DOM-free so both surfaces share the exact wording.
 *--------------------------------------------------------------------------------------------*/

/** First non-empty line of a block of text, trimmed. */
export function firstNonEmptyLine(text: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length > 0) return trimmed
  }
  return ''
}

/** First line of a message, trimmed and clamped, for the collapsed single-line summary. */
export function firstLineSummary(text: string): string {
  const firstLine = text.split('\n', 1)[0]?.trim() ?? ''
  const MAX = 120
  return firstLine.length > MAX ? `${firstLine.slice(0, MAX)}…` : firstLine
}

/**
 * Strip the whole-block code fence added to tool results: when the client does
 * not advertise terminal-output support, shell output is wrapped in a
 * ```console fence and error text in a bare ``` fence (see
 * vendor/claude-agent-acp's `toolUpdateFromToolResult`). Only strips when the
 * whole text is exactly one fence — content with extra sections or its own
 * backticks is returned unchanged so nothing is damaged.
 */
export function stripCodeFence(text: string): string {
  const m = /^```(?:\w*)?\n([\s\S]*?)\n```$/.exec(text.trim())
  return m?.[1] ?? text
}

/** Compact elapsed text: `59s` below a minute, `m:ss` from one minute up. */
export function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000)
  const m = Math.floor(s / 60)
  if (m > 0) return `${m}:${String(s % 60).padStart(2, '0')}`
  return `${s}s`
}
