/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Pure helper for detecting the active `#`-context token in the agent prompt
 *  input. `extractHashQuery(text, caret)` reports the `#<query>` token under the
 *  caret so the popover knows what to filter — same caret/boundary rules as
 *  `extractMentionQuery`, `#` in place of `@`.
 *
 *  Reference serialization no longer lives here: once picked, a context ref
 *  becomes a range-tracked pill (see promptRefTracker.ts) mapped to its wire
 *  block on submit by composePromptBlocksFromRefs (promptRef.ts).
 *--------------------------------------------------------------------------------------------*/

export type PromptContextRefKind = 'symbol' | 'scmChange' | 'openEditor' | 'docs'

export interface ActiveHashQuery {
  readonly query: string
  /** Index of the `#` in `text`. */
  readonly startIndex: number
  /** One past the last character of the token (exclusive). */
  readonly endIndex: number
}

/**
 * If the caret sits inside an in-progress `#<token>` (no whitespace between
 * `#` and the cursor), return the substring after `#` plus the token range so
 * callers can replace it on pick. Otherwise null — collapse the popover.
 *
 * The `#` must be at the start of `text` or preceded by whitespace, mirroring
 * {@link extractMentionQuery} in promptMentions.ts.
 */
export function extractHashQuery(text: string, caret: number): ActiveHashQuery | null {
  if (caret < 0 || caret > text.length) return null
  let i = caret - 1
  while (i >= 0) {
    const ch = text[i]!
    if (/\s/.test(ch)) return null
    if (ch === '#') {
      if (i > 0 && !/\s/.test(text[i - 1]!)) return null
      let end = i + 1
      while (end < text.length && !/\s/.test(text[end]!)) end++
      if (caret > end) return null
      return { query: text.slice(i + 1, end), startIndex: i, endIndex: end }
    }
    i--
  }
  return null
}
