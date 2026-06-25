/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Local USD cost estimation for Codex turns. Codex (unlike Claude) never reports
 *  an authoritative cost — whether the user signs in with an API key or a
 *  subscription, we estimate from token counts against OpenAI's public per-token
 *  pricing. The result is always labelled an estimate in the UI.
 *
 *  Prices are USD per 1M tokens, taken from OpenAI's published gpt-5.x API
 *  pricing. Reasoning tokens are billed as output tokens, so they are already
 *  folded into `outputTokens` by codex-acp's TokenCount mapping and need no
 *  separate rate.
 *--------------------------------------------------------------------------------------------*/

import type { PromptResponse } from '@agentclientprotocol/sdk'

/** USD per 1M tokens for one model family. */
export interface CodexModelPricing {
  /** Non-cached input tokens. */
  readonly input: number
  /** Cached (prompt-cache read) input tokens — discounted. */
  readonly cachedInput: number
  /** Output tokens (reasoning tokens are billed at the output rate). */
  readonly output: number
}

/**
 * Per-family pricing keyed by a normalized model family. Lookup folds the concrete
 * model id down to its family via {@link codexModelFamily}, so reasoning-effort or
 * date-suffixed ids (e.g. `gpt-5.4-codex[high]`) resolve without an exact-match
 * table — unpriced variants of a version (e.g. `gpt-5.4-codex`) fall back to that
 * version's base tier (`gpt-5.4`).
 */
const PRICING: Readonly<Record<string, CodexModelPricing>> = {
  'gpt-5.3-chat': { input: 1.75, cachedInput: 0.175, output: 14 },
  'gpt-5.3-codex': { input: 1.75, cachedInput: 0.175, output: 14 },
  'gpt-5.4': { input: 2.5, cachedInput: 0.25, output: 15 },
  'gpt-5.4-mini': { input: 0.75, cachedInput: 0.075, output: 4.5 },
  'gpt-5.4-nano': { input: 0.2, cachedInput: 0.02, output: 1.25 },
  'gpt-5.4-pro': { input: 30, cachedInput: 0, output: 180 },
  'gpt-5.5': { input: 5, cachedInput: 0.5, output: 30 },
}

/** Priced family keys, longest first so the most specific variant wins. */
const PRICING_KEYS: readonly string[] = Object.keys(PRICING).sort((a, b) => b.length - a.length)

/** Family used when a model id matches no priced tier — the current flagship. */
const DEFAULT_FAMILY = 'gpt-5.4'
const DEFAULT_PRICING: CodexModelPricing = PRICING[DEFAULT_FAMILY]!

/** Token tally for one model accumulated across a session's turns. */
export interface CodexTokenTally {
  /** Non-cached input tokens. */
  readonly inputTokens: number
  /** Cached (prompt-cache read) input tokens. */
  readonly cachedReadTokens: number
  /** Output tokens (includes reasoning). */
  readonly outputTokens: number
}

/**
 * Normalize a Codex model id to a priced family. Strips reasoning-effort (`[high]`)
 * and date suffixes, then exact-matches the pricing table; failing that, folds an
 * unpriced variant down to its version's base tier (`gpt-5.4-codex` → `gpt-5.4`).
 * Unknown ids resolve to {@link DEFAULT_FAMILY}.
 */
export function codexModelFamily(modelId: string): string {
  const id = modelId
    .toLowerCase()
    .replace(/\[.*?\]$/, '')
    .replace(/-\d{4}-\d{2}-\d{2}$/, '')
    .replace(/-\d{8}$/, '')
    .trim()
  for (const key of PRICING_KEYS) {
    if (id === key || id.startsWith(`${key}-`)) return key
  }
  return DEFAULT_FAMILY
}

export function codexModelPricing(modelId: string): CodexModelPricing {
  return PRICING[codexModelFamily(modelId)] ?? DEFAULT_PRICING
}

/** Estimated USD cost for one model's accumulated token tally. */
export function estimateCodexCostUSD(modelId: string, tally: CodexTokenTally): number {
  const p = codexModelPricing(modelId)
  return (
    (tally.inputTokens * p.input +
      tally.cachedReadTokens * p.cachedInput +
      tally.outputTokens * p.output) /
    1_000_000
  )
}

/** One model's token usage parsed from a Codex quota snapshot. */
export interface CodexModelUsage {
  readonly model: string
  readonly inputTokens: number
  readonly cachedReadTokens: number
  readonly outputTokens: number
}

function numberOr(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0
}

function parseModelUsageItem(item: unknown): CodexModelUsage | null {
  if (item == null || typeof item !== 'object') return null
  const r = item as Record<string, unknown>
  const model = typeof r['model'] === 'string' ? r['model'] : DEFAULT_FAMILY
  const tc = (r['token_count'] ?? {}) as Record<string, unknown>
  const inputTokens = numberOr(tc['inputTokens'])
  const cachedReadTokens = numberOr(tc['cachedInputTokens'])
  const outputTokens = numberOr(tc['outputTokens'])
  if (inputTokens + cachedReadTokens + outputTokens === 0) return null
  return { model, inputTokens, cachedReadTokens, outputTokens }
}

/**
 * Parse the session-cumulative, per-model token usage codex-acp stamps onto every
 * `usage_update`'s `_meta.quota.model_usage` (token counts are already net of
 * cached input — see codex-acp TokenCount). The fork reports a running total on
 * each model call, so this snapshot already folds in every call a prompt made —
 * callers should take the latest snapshot rather than accumulate. Returns [] when
 * absent or empty.
 */
export function extractCodexModelUsage(meta: unknown): readonly CodexModelUsage[] {
  const m = meta as { quota?: { model_usage?: unknown } | null | undefined } | null | undefined
  const modelUsage = m?.quota?.model_usage
  if (!Array.isArray(modelUsage)) return []
  const out: CodexModelUsage[] = []
  for (const item of modelUsage) {
    const parsed = parseModelUsageItem(item)
    if (parsed != null) out.push(parsed)
  }
  return out
}

/**
 * Parse the per-turn, per-model token usage codex-acp stamps onto each
 * PromptResponse via `_meta.quota.model_usage`. Falls back to the flat `usage`
 * field under the default-family bucket when the quota meta is absent. Returns []
 * when no usable token data is present.
 */
export function extractCodexTurnUsage(response: PromptResponse): readonly CodexModelUsage[] {
  const fromMeta = extractCodexModelUsage(response._meta)
  if (fromMeta.length > 0) return fromMeta

  const usage = response.usage
  if (usage == null) return []
  const inputTokens = numberOr(usage.inputTokens)
  const cachedReadTokens = numberOr(usage.cachedReadTokens)
  const outputTokens = numberOr(usage.outputTokens)
  if (inputTokens + cachedReadTokens + outputTokens === 0) return []
  return [{ model: DEFAULT_FAMILY, inputTokens, cachedReadTokens, outputTokens }]
}
