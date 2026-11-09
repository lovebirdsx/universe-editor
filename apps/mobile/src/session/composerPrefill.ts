import { MAX_SIDE_TASK_QUOTE_LENGTH } from '@universe-editor/mobile-protocol'

/**
 * One-shot composer backfills (rewind text / side-task quote). Keyed by route
 * key instead of storing on the session summary: the value is consumed exactly
 * once and never travels over the wire.
 */
const pendingPrefill = new Map<string, string>()

export function depositComposerPrefill(sessionKey: string, text: string): void {
  if (text.length === 0) return
  pendingPrefill.set(sessionKey, text)
}

export function takeComposerPrefill(sessionKey: string): string | undefined {
  const text = pendingPrefill.get(sessionKey)
  if (text === undefined) return undefined
  pendingPrefill.delete(sessionKey)
  return text
}

/**
 * Same trim / 8000-char clip as the desktop side-task command, but the result
 * must also fit the protocol's quote limit — the ellipsis counts toward it.
 */
export function clipSideTaskQuote(text: string): string {
  const trimmed = text.trim()
  if (trimmed.length <= MAX_SIDE_TASK_QUOTE_LENGTH) return trimmed
  return `${trimmed.slice(0, MAX_SIDE_TASK_QUOTE_LENGTH - 1)}…`
}

/** Markdown blockquote that pre-fills a side task; mirrors agentSessionActions.ts. */
export function sideTaskQuoteText(text: string): string {
  const clipped = clipSideTaskQuote(text)
  if (clipped.length === 0) return ''
  const quoted = clipped
    .split('\n')
    .map((line) => (line.trim().length === 0 ? '>' : `> ${line}`))
    .join('\n')
  return `${quoted}\n\n`
}

export function _resetComposerPrefillForTests(): void {
  pendingPrefill.clear()
}
