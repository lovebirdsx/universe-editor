/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Catalog helpers. Model metadata and per-vendor official rate tables moved to
 *  modelKnowledge.ts; rate resolution moved to resolveProviderPricing.ts. What
 *  remains is id normalization plus exact Anthropic membership (used by the
 *  Claude CLI cost-trust check).
 *--------------------------------------------------------------------------------------------*/

import { stripModelLaneSuffix } from '@universe-editor/platform'
import type { AiRemoteSourceSpec } from '@universe-editor/platform'
import { ANTHROPIC_CATALOG } from './anthropic.js'
import { MOONSHOT_CATALOG } from './moonshot.js'
import { readCatalogVendor } from './modelKnowledge.js'

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

const MOONSHOT_IDS: ReadonlySet<string> = new Set(
  Object.keys(MOONSHOT_CATALOG).map(normalizeCatalogModelId),
)

/**
 * Whether a wire `inputTokens` figure already includes the cached tokens, i.e.
 * the cached share would be billed twice if priced at the input rate AND again
 * at the cache rate. Anthropic and OpenAI usage EXCLUDE cached tokens from
 * `input_tokens`; Moonshot (Kimi) gateways INCLUDE both cache reads and cache
 * writes (empirically verified). DeepSeek's official API reports
 * `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens` separately — the same
 * exclude semantics as Anthropic — so it is NOT treated as include-cached.
 * Callers pricing an include-cached row must deduct cacheRead + cacheCreate
 * from input first.
 *
 * Attribution, in precedence order:
 *  1. explicit override — `pricingSource.options.inputTokens: 'include-cached'`
 *     / `'exclude-cached'` in aiSettings.json. This is the escape hatch for a
 *     gateway the attribution below gets wrong (e.g. a renamed Kimi deployment
 *     the catalog membership check cannot recognize, or a non-official
 *     DeepSeek deployment that does fold cache hits into input_tokens). The
 *     main process ignores unknown option keys, so the same pricingSource
 *     keeps fetching as before.
 *  2. `catalog` source: the declared vendor decides — 'moonshot' includes
 *     cached tokens, every other vendor excludes them.
 *  3. gateway (`http-json`) source: exact built-in catalog membership of the
 *     normalized wire name (lane suffixes like `[1m]` and casing are stripped
 *     by `normalizeCatalogModelId`). A gateway that renames a Kimi model is
 *     not recognized and stays un-normalized — use the override.
 *  4. no pricing source: the channel is unattributed, so the name alone proves
 *     nothing (a catalog member could still be a renamed Anthropic-semantics
 *     deployment) — never deduct.
 */
export function inputTokensIncludeCached(
  bareModelId: string,
  pricingSource?: AiRemoteSourceSpec,
): boolean {
  const override = pricingSource?.options?.['inputTokens']
  if (override === 'include-cached') return true
  if (override === 'exclude-cached') return false
  if (pricingSource !== undefined && pricingSource.id === 'catalog') {
    const vendor = readCatalogVendor(pricingSource.options)
    return vendor === 'moonshot'
  }
  if (pricingSource === undefined) return false
  const id = normalizeCatalogModelId(bareModelId)
  return MOONSHOT_IDS.has(id)
}
