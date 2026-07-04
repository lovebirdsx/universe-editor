/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Unified prompt-reference model for the agent input.
 *
 *  A PromptRef is a single structured reference the user embedded in the prompt:
 *  an `@` file/folder mention or a `#` structured-context reference (workspace
 *  symbol / local Git change / open editor / user docs). Both share one model so
 *  the input tracks and renders them the same way — VSCode Copilot-style pills
 *  tracked by character range rather than by name.
 *
 *  Two pure stages (the range tracking against a live Monaco model lives in
 *  promptRefTracker.ts, not here):
 *    1) While typing, `extractActiveToken(text, caret)` reports the active
 *       `@<query>` / `#<query>` token so the popover knows what to filter.
 *    2) On submit, `composePromptBlocksFromRefs(text, placed)` slices the text
 *       at each ref's tracked range and maps every ref to its wire ContentBlock
 *       via `composeRefBlock` — it never re-tokenizes the text, so a reference
 *       whose display text contains spaces (a symbol like `foo bar`, a doc title)
 *       round-trips correctly. That's the whole reason this replaces the old
 *       by-name walk in promptMentions.ts.
 *--------------------------------------------------------------------------------------------*/

import type { ContentBlock } from '@agentclientprotocol/sdk'
import { generateUuid, localize } from '@universe-editor/platform'
import type { ContextSuggestionItem } from './contextSuggestions.js'

export type PromptRefKind = 'file' | 'folder' | 'symbol' | 'scmChange' | 'openEditor' | 'docs'

export interface PromptRef {
  /** Stable id (per insertion), used to key the tracked decoration. */
  readonly id: string
  readonly kind: PromptRefKind
  /** Text shown inside the pill WITHOUT the leading `@`/`#`; also the `name` on the wire block. */
  readonly label: string
  /** Target resource URI (for `docs`, the documentation root URI). */
  readonly uri: string
  /** kind-specific location/display info consumed by composeRefBlock. */
  readonly meta?: {
    readonly line?: number
    readonly column?: number
    readonly symbolKind?: number
    readonly scmStatus?: string
    readonly description?: string
  }
}

/** A PromptRef placed at a character range in the prompt text (from the tracker). */
export interface PlacedRef {
  readonly ref: PromptRef
  /** Offset of the leading `@`/`#` in the text (inclusive). */
  readonly start: number
  /** Offset one past the last character of the token (exclusive). */
  readonly end: number
}

const PREFIX_BY_KIND: Record<PromptRefKind, '@' | '#'> = {
  file: '@',
  folder: '@',
  symbol: '#',
  scmChange: '#',
  openEditor: '#',
  docs: '#',
}

/** The trigger char (`@` for mentions, `#` for structured context) for a ref kind. */
export function refPrefix(kind: PromptRefKind): '@' | '#' {
  return PREFIX_BY_KIND[kind]
}

/** The full token as it appears in the text, e.g. `@src/a.ts` or `#foo bar`. */
export function refDisplay(ref: PromptRef): string {
  return `${refPrefix(ref.kind)}${ref.label}`
}

export interface ActiveToken {
  readonly prefix: '@' | '#'
  readonly query: string
  /** Index of the `@`/`#` in `text`. */
  readonly startIndex: number
  /** One past the last character of the token (exclusive). */
  readonly endIndex: number
}

/**
 * If the caret sits inside an in-progress `@<token>` / `#<token>` (no whitespace
 * between the trigger char and the cursor), return the prefix, the substring
 * after it, and the token range so callers can replace it on pick. Otherwise
 * null — collapse the popover.
 *
 * The trigger char must be at the start of `text` or preceded by whitespace;
 * this rules out mid-word matches like `email@host.com` or `issue#42` inside a
 * word. A single token can only carry one prefix, so `@` and `#` are mutually
 * exclusive per token.
 */
export function extractActiveToken(text: string, caret: number): ActiveToken | null {
  if (caret < 0 || caret > text.length) return null
  let i = caret - 1
  while (i >= 0) {
    const ch = text[i]!
    if (/\s/.test(ch)) return null
    if (ch === '@' || ch === '#') {
      if (i > 0 && !/\s/.test(text[i - 1]!)) return null
      let end = i + 1
      while (end < text.length && !/\s/.test(text[end]!)) end++
      if (caret > end) return null
      return { prefix: ch, query: text.slice(i + 1, end), startIndex: i, endIndex: end }
    }
    i--
  }
  return null
}

/** Map one ref to its wire ContentBlock per kind (mirrors the plan's decision table). */
export function composeRefBlock(ref: PromptRef): ContentBlock {
  switch (ref.kind) {
    case 'symbol': {
      // Built-in agents (claude-agent-acp / codex-acp) serialize a resource_link
      // as just its uri (+ name), dropping `description` and `_meta` — so a
      // symbol's line/column would be lost at the protocol boundary and the agent
      // would read the whole file. Encode the location into a `text` block, the
      // only channel both agents pass through verbatim, so `#Student` points at
      // the exact symbol + line rather than the file.
      const meta = ref.meta
      const location = meta?.description ?? ref.uri
      const lineSuffix = meta?.line !== undefined ? `:${meta.line}` : ''
      const columnSuffix = meta?.column !== undefined ? `:${meta.column}` : ''
      return {
        type: 'text',
        text: `\`${ref.label}\` (${location}${lineSuffix}${columnSuffix})`,
        _meta: {
          symbol: {
            uri: ref.uri,
            name: ref.label,
            ...(meta?.line !== undefined ? { line: meta.line } : {}),
            ...(meta?.column !== undefined ? { column: meta.column } : {}),
            ...(meta?.symbolKind !== undefined ? { kind: meta.symbolKind } : {}),
          },
        },
      }
    }
    case 'file':
    case 'folder':
    case 'openEditor':
      return { type: 'resource_link', uri: ref.uri, name: ref.label }
    case 'scmChange':
      return {
        type: 'resource_link',
        uri: ref.uri,
        name: ref.label,
        ...(ref.meta?.scmStatus !== undefined ? { description: ref.meta.scmStatus } : {}),
      }
    case 'docs':
      return {
        type: 'text',
        text:
          ref.meta?.description ??
          localize('acp.contextRef.docs.fallback', 'Documentation available at {uri}', {
            uri: ref.uri,
          }),
      }
  }
}

/**
 * Slice `text` at each placed ref's range and interleave text blocks with the
 * mapped reference blocks. Placed refs may arrive unsorted and are ordered by
 * start offset here; overlapping/out-of-bounds ranges are skipped defensively.
 * Adjacent text is preserved as-is (no trimming). Pure / synchronous.
 */
export function composePromptBlocksFromRefs(
  text: string,
  placed: readonly PlacedRef[],
): readonly ContentBlock[] {
  if (text.length === 0) return []
  if (placed.length === 0) return [{ type: 'text', text }]

  const sorted = [...placed]
    .filter((p) => p.start >= 0 && p.end <= text.length && p.start < p.end)
    .sort((a, b) => a.start - b.start)

  const blocks: ContentBlock[] = []
  let cursor = 0
  for (const p of sorted) {
    if (p.start < cursor) continue // overlaps a previous ref — skip defensively
    if (p.start > cursor) blocks.push({ type: 'text', text: text.slice(cursor, p.start) })
    blocks.push(composeRefBlock(p.ref))
    cursor = p.end
  }
  if (cursor < text.length) blocks.push({ type: 'text', text: text.slice(cursor) })
  return blocks
}

// A symbol suggestion's `description` already bakes in `:line` for display, but
// composeRefBlock's symbol case re-appends `:${line}` to meta.description — strip
// it here so the round-trip doesn't double up the suffix.
function stripLineSuffix(description: string, line: number | undefined): string {
  if (line === undefined) return description
  const suffix = `:${line}`
  return description.endsWith(suffix) ? description.slice(0, -suffix.length) : description
}

/** Build a PromptRef from a `#`-context popover suggestion (fresh id per pick). */
export function suggestionItemToRef(item: ContextSuggestionItem): PromptRef {
  const base = { id: generateUuid(), label: item.label, uri: item.uri }
  switch (item.kind) {
    case 'symbol':
      return {
        ...base,
        kind: 'symbol',
        meta: {
          ...(item.meta?.line !== undefined ? { line: item.meta.line } : {}),
          ...(item.meta?.column !== undefined ? { column: item.meta.column } : {}),
          ...(item.meta?.symbolKind !== undefined ? { symbolKind: item.meta.symbolKind } : {}),
          description: stripLineSuffix(item.description, item.meta?.line),
        },
      }
    case 'scmChange':
      return {
        ...base,
        kind: 'scmChange',
        ...(item.meta?.scmStatus !== undefined ? { meta: { scmStatus: item.meta.scmStatus } } : {}),
      }
    case 'openEditor':
      return { ...base, kind: 'openEditor' }
    case 'docs':
      return { ...base, kind: 'docs', meta: { description: item.description } }
  }
}

/** Build a PromptRef from an `@`-mention file/folder pick (fresh id per pick). */
export function mentionEntryToRef(
  entry: { readonly uri: string; readonly relPath: string },
  kind: 'file' | 'folder' = 'file',
): PromptRef {
  return { id: generateUuid(), kind, label: entry.relPath, uri: entry.uri }
}
