/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Pure helpers for detecting the active `@`-mention token in the agent prompt
 *  input. `extractMentionQuery(text, caret)` reports the `@<query>` token under
 *  the caret so the popover knows what to filter; `detectFilePickerTrigger`
 *  spots the `@@`/`@#` file/folder picker shortcuts.
 *
 *  Reference serialization no longer lives here: once picked, a mention becomes
 *  a range-tracked pill (see promptRefTracker.ts) and is serialized on submit by
 *  composePromptBlocksFromRefs (promptRef.ts) — never re-tokenized by name.
 *--------------------------------------------------------------------------------------------*/

export interface ActiveMentionQuery {
  readonly query: string
  /** Index of the `@` in `text`. */
  readonly startIndex: number
  /** One past the last character of the token (exclusive). */
  readonly endIndex: number
}

/**
 * If the caret sits inside an in-progress `@<token>` (no whitespace between
 * `@` and the cursor), return the substring after `@` plus the token range so
 * callers can replace it on pick. Otherwise null — collapse the popover.
 *
 * The `@` must be at the start of `text` or preceded by whitespace; this
 * rules out mid-word matches like `email@host.com`.
 */
export function extractMentionQuery(text: string, caret: number): ActiveMentionQuery | null {
  if (caret < 0 || caret > text.length) return null
  // Walk back from the caret until we hit whitespace (no active token) or `@`.
  let i = caret - 1
  while (i >= 0) {
    const ch = text[i]!
    if (/\s/.test(ch)) return null
    if (ch === '@') {
      // Must be at start of buffer or preceded by whitespace.
      if (i > 0 && !/\s/.test(text[i - 1]!)) return null
      // Extend forward to the end of the contiguous non-whitespace token.
      let end = i + 1
      while (end < text.length && !/\s/.test(text[end]!)) end++
      // Caret must lie within `[@, end]` for the query to be "active".
      if (caret > end) return null
      return { query: text.slice(i + 1, end), startIndex: i, endIndex: end }
    }
    i--
  }
  return null
}

export type FilePickerTriggerKind = 'file' | 'folder'

export interface FilePickerTrigger {
  readonly kind: FilePickerTriggerKind
  /** Index of the leading `@` — the two-char trigger spans `[start, start + 2)`. */
  readonly start: number
}

/**
 * Detect a just-typed file/folder picker trigger sitting immediately before the
 * caret: `@@` opens a file picker, `@#` a folder picker. The leading `@` must be
 * at a mention boundary (start of text or after whitespace) — same rule as
 * {@link extractMentionQuery} — so `email@@host` won't fire. The caret must be
 * right after the two trigger chars, so this only matches the moment the second
 * char lands. Returns null when there's no trigger.
 */
export function detectFilePickerTrigger(text: string, caret: number): FilePickerTrigger | null {
  if (caret < 2 || caret > text.length) return null
  const start = caret - 2
  if (text[start] !== '@') return null
  if (start > 0 && !/\s/.test(text[start - 1]!)) return null
  const second = text[start + 1]
  if (second === '@') return { kind: 'file', start }
  if (second === '#') return { kind: 'folder', start }
  return null
}
