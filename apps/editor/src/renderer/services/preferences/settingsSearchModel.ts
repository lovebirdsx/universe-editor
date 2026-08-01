/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Settings search model: query parsing (`@modified`, `@id:`) and tiered
 *  relevance ranking. Pure functions — the settings editor feeds registry
 *  entries in and renders the surviving order.
 *--------------------------------------------------------------------------------------------*/

import { wordMatchField } from '@universe-editor/workbench-ui'

export interface ParsedSettingsQuery {
  /** `@modified` token present: keep only settings owned by the viewed layer. */
  readonly modifiedOnly: boolean
  /** `@id:editor.font` → 'editor.font' (key-prefix locate, `*` suffix allowed). */
  readonly idPrefix: string | undefined
  /** Remaining free text, lower-cased and whitespace-collapsed. */
  readonly text: string
}

export function parseQuery(raw: string): ParsedSettingsQuery {
  let modifiedOnly = false
  let idPrefix: string | undefined
  const rest: string[] = []
  for (const token of raw.trim().split(/\s+/)) {
    if (!token) continue
    if (token.toLowerCase() === '@modified') {
      modifiedOnly = true
      continue
    }
    const idMatch = /^@id:(.+)$/i.exec(token)
    if (idMatch) {
      idPrefix = idMatch[1]!.replace(/\*$/, '').toLowerCase()
      continue
    }
    rest.push(token)
  }
  return { modifiedOnly, idPrefix, text: rest.join(' ').toLowerCase() }
}

export interface SettingSearchEntry {
  readonly key: string
  readonly description: string
  /** Registration order across the whole registry — final tie-breaker. */
  readonly order: number
  /** Whether the viewed target layer owns this key (for `@modified`). */
  readonly isModified: boolean
}

// Score tiers: a higher tier always beats any lower-tier match regardless of
// the in-tier adjustments (which only shorten by key length).
const SCORE_NO_MATCH = -1
const SCORE_ID_PREFIX = 10000
const SCORE_KEY_EXACT = 4000
const SCORE_KEY_PREFIX = 3000
const SCORE_KEY_SUBSTRING = 2000
const SCORE_KEY_WORDS = 1000
const SCORE_DESCRIPTION = 500

/**
 * Relevance score for one entry against a parsed query; -1 = filtered out.
 * `@modified` is a pure filter (no score influence). With an `@id:` prefix the
 * key must start with it; free text then ranks by key exact > key prefix >
 * key substring > word match > description-all-words. An empty text keeps the
 * entry at score 0 (registration order decides).
 */
export function rankEntry(entry: SettingSearchEntry, query: ParsedSettingsQuery): number {
  if (query.modifiedOnly && !entry.isModified) return SCORE_NO_MATCH

  const key = entry.key.toLowerCase()
  if (query.idPrefix !== undefined && !key.startsWith(query.idPrefix)) return SCORE_NO_MATCH
  if (!query.text) {
    return query.idPrefix !== undefined ? SCORE_ID_PREFIX - key.length : 0
  }

  const text = query.text
  if (key === text) return SCORE_KEY_EXACT
  if (key.startsWith(text)) return SCORE_KEY_PREFIX - key.length
  if (key.includes(text)) return SCORE_KEY_SUBSTRING - key.length
  if (wordMatchField(key, text)) return SCORE_KEY_WORDS - key.length

  // Description fallback: every whitespace-separated word must appear, so
  // multi-word queries don't explode into noise.
  const desc = entry.description.toLowerCase()
  if (desc) {
    const words = text.split(' ').filter((w) => w.length > 0)
    if (words.length > 0 && words.every((w) => desc.includes(w))) {
      return SCORE_DESCRIPTION - key.length
    }
  }
  return SCORE_NO_MATCH
}

export interface RankedSetting {
  readonly key: string
  readonly score: number
  readonly order: number
}

/** Filter + rank entries; survivors come out sorted by score desc, then registration order. */
export function filterAndRankSettings(
  entries: readonly SettingSearchEntry[],
  query: ParsedSettingsQuery,
): RankedSetting[] {
  const ranked: RankedSetting[] = []
  for (const entry of entries) {
    const score = rankEntry(entry, query)
    if (score === SCORE_NO_MATCH) continue
    ranked.push({ key: entry.key, score, order: entry.order })
  }
  ranked.sort((a, b) => b.score - a.score || a.order - b.order)
  return ranked
}
