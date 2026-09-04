/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Catalog helpers. Model metadata and per-vendor official rate tables moved to
 *  modelKnowledge.ts; rate resolution moved to resolveProviderPricing.ts. What
 *  remains is id normalization plus exact Anthropic membership (used by the
 *  Claude CLI cost-trust check).
 *--------------------------------------------------------------------------------------------*/

import { stripModelLaneSuffix } from '@universe-editor/platform'
import { ANTHROPIC_CATALOG } from './anthropic.js'

/**
 * Drop a trailing context/effort hint (`[1m]` / `[high]`) and nothing else — no
 * casing, no date snapshots. Rate lookups need exactly this much: the hint marks
 * a lane of the same model, so a table keyed by the bare name still applies, while
 * a table that prices the lane separately must keep winning on the exact key.
 */
export function stripTrailingBracketSuffix(id: string): string {
  return stripModelLaneSuffix(id)
}

/**
 * Strip lossless, non-identity suffixes from a model id: casing, whitespace,
 * context/effort hints (`[1m]` / `[high]`) and trailing date snapshots. The
 * remaining id is still the same model — this is not family guessing.
 */
export function normalizeCatalogModelId(id: string): string {
  return stripTrailingBracketSuffix(id.trim().toLowerCase())
    .replace(/-\d{4}-\d{2}-\d{2}$/, '')
    .replace(/-\d{8}$/, '')
}

/**
 * Anthropic spells the version segment with hyphens (`claude-opus-4-8`) while
 * gateways sometimes declare it dotted (`claude-opus-4.8`), and the CLI resolves
 * ids exactly so the dotted form fails the API call. Rewrite the dot only inside
 * the `claude-<family>-<major>.<minor>` shape — never a blanket
 * `.replace(/\./g, '-')`, which would mangle third-party ids like
 * `gpt-5.2-codex`. Lane hints are stripped before the rewrite and re-appended
 * after, so `claude-opus-4.8[1m]` becomes `claude-opus-4-8[1m]`.
 */
export function normalizeAnthropicVersionDots(id: string): string {
  const bare = stripTrailingBracketSuffix(id)
  const suffix = id.slice(bare.length)
  const m = /^claude-([a-z]+)-(\d+)\.(\d+)$/i.exec(bare)
  const family = m?.[1]
  const major = m?.[2]
  const minor = m?.[3]
  if (family === undefined || major === undefined || minor === undefined) return id
  return `claude-${family.toLowerCase()}-${major}-${minor}${suffix}`
}

const ANTHROPIC_IDS: ReadonlySet<string> = new Set(
  Object.keys(ANTHROPIC_CATALOG).map(normalizeCatalogModelId),
)

/**
 * Whether a bare model id is one of Anthropic's own models. Exact catalog
 * membership, not a name-prefix guess — callers use it to decide whether the
 * Claude CLI's self-reported cost can be trusted for that row.
 */
export function isAnthropicCatalogModel(bareModelId: string): boolean {
  return ANTHROPIC_IDS.has(normalizeCatalogModelId(bareModelId))
}
