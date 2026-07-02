/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Pure helpers for the @-mention pipeline in the agent prompt input.
 *
 *  Two-stage flow:
 *    1) While the user types, `extractMentionQuery(text, caret)` reports the
 *       active `@<query>` token (if any) so the popover knows what to filter.
 *       Caret-aware: only fires when the cursor is inside the token.
 *    2) On submit, `composePromptBlocks(text, mentions)` walks the final text
 *       and turns any `@<name>` whose `<name>` matches a recorded mention into
 *       a `resource_link` ContentBlock. Unrecorded names stay as text — so
 *       the user can still type literal `@username` without it being treated
 *       as a file reference.
 *
 *  Range tracking is deliberately omitted: we identify mentions by name (the
 *  string the user picked) rather than by character ranges. If the user
 *  rewrites the mention text the link silently disappears, which matches
 *  intuition — and avoids the diff-bookkeeping rabbit hole.
 *--------------------------------------------------------------------------------------------*/

import type { ContentBlock } from '@agentclientprotocol/sdk'

export interface PromptMention {
  /** Absolute URI of the resource (typically `file:///...`). */
  readonly uri: string
  /** Display token, inserted verbatim after `@` into the text. */
  readonly name: string
}

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

/**
 * Replace the active `@<query>` token (range `[startIndex, endIndex)`) with
 * `@<name> ` (trailing space so the user can keep typing). Returns the new
 * text plus the new caret position. Pure — does not touch React state.
 */
export function applyMentionPick(
  text: string,
  range: { readonly startIndex: number; readonly endIndex: number },
  name: string,
): { text: string; caret: number } {
  const before = text.slice(0, range.startIndex)
  const after = text.slice(range.endIndex)
  // Insert a trailing space only if the next char isn't already whitespace.
  const needsTrailingSpace = after.length === 0 || !/\s/.test(after[0]!)
  const insert = `@${name}${needsTrailingSpace ? ' ' : ''}`
  const newText = before + insert + after
  return { text: newText, caret: before.length + insert.length }
}

/**
 * Tokenize `text` into ContentBlocks, expanding every `@<name>` whose
 * `<name>` matches a recorded mention into a `resource_link` block. Adjacent
 * text is merged. Pure / synchronous; does NOT contact the network.
 *
 * Boundary rules: the `@` must be at start-of-text or preceded by whitespace
 * (same as {@link extractMentionQuery}), and the token ends at the next
 * whitespace or end-of-text.
 */
export function composePromptBlocks(
  text: string,
  mentions: readonly PromptMention[],
): readonly ContentBlock[] {
  if (text.length === 0) return []
  if (mentions.length === 0) return [{ type: 'text', text }]
  const byName = new Map<string, PromptMention>()
  for (const m of mentions) byName.set(m.name, m)

  const blocks: ContentBlock[] = []
  let bufStart = 0
  let i = 0
  while (i < text.length) {
    if (text[i] === '@') {
      const okBoundary = i === 0 || /\s/.test(text[i - 1]!)
      if (okBoundary) {
        let end = i + 1
        while (end < text.length && !/\s/.test(text[end]!)) end++
        const name = text.slice(i + 1, end)
        const mention = byName.get(name)
        if (mention) {
          if (i > bufStart) blocks.push({ type: 'text', text: text.slice(bufStart, i) })
          blocks.push({ type: 'resource_link', uri: mention.uri, name: mention.name })
          i = end
          bufStart = end
          continue
        }
      }
    }
    i++
  }
  if (bufStart < text.length) blocks.push({ type: 'text', text: text.slice(bufStart) })
  return blocks
}
