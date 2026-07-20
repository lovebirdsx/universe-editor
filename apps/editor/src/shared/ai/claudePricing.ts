/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Local USD cost estimation for Claude sub-agent (Task) work. Claude reports an
 *  authoritative session-cumulative cost, but never a per-sub-agent breakdown, so
 *  a sub-agent card's cost is estimated from the token counts its own assistant
 *  messages carry (folded per parent tool call in the agent fork) against
 *  Anthropic's published per-token pricing. The result is always labelled an
 *  estimate in the UI.
 *
 *  Prices are USD per 1M tokens. Unlike Codex, Claude bills prompt-cache writes
 *  (creation) and reads at distinct rates, so four tiers are tracked.
 *--------------------------------------------------------------------------------------------*/

/** USD per 1M tokens for one model family. */
export interface ClaudeModelPricing {
  /** Non-cached input tokens. */
  readonly input: number
  /** Prompt-cache write (creation) tokens — a premium over base input. */
  readonly cacheWrite: number
  /** Prompt-cache read tokens — heavily discounted. */
  readonly cacheRead: number
  /** Output tokens (thinking tokens are billed at the output rate). */
  readonly output: number
}

/**
 * Per-family pricing keyed by a normalized model family. Lookup folds the concrete
 * model id (e.g. `claude-opus-4-8`, `claude-sonnet-5[1m]`) down to its family via
 * {@link claudeModelFamily}, so version/date/context-hint suffixes resolve without
 * an exact-match table.
 */
const PRICING: Readonly<Record<string, ClaudeModelPricing>> = {
  'claude-fable': { input: 10, cacheWrite: 12.5, cacheRead: 1, output: 50 },
  'claude-opus': { input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 },
  'claude-sonnet': { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
  'claude-haiku': { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 },
}

/** Family used when a model id matches no priced tier — the current flagship. */
const DEFAULT_FAMILY = 'claude-sonnet'
const DEFAULT_PRICING: ClaudeModelPricing = PRICING[DEFAULT_FAMILY]!

/** Token tally for one model accumulated across a sub-agent's messages. */
export interface ClaudeTokenTally {
  /** Non-cached input tokens. */
  readonly inputTokens: number
  /** Prompt-cache write (creation) tokens. */
  readonly cacheCreateTokens: number
  /** Prompt-cache read tokens. */
  readonly cacheReadTokens: number
  /** Output tokens (includes thinking). */
  readonly outputTokens: number
}

/**
 * Normalize a Claude model id to a priced family. Claude ids embed the tier as a
 * `claude-<tier>-<version>` prefix (`claude-opus-4-8`, `claude-sonnet-5[1m]`,
 * `claude-3-5-haiku-20241022`), so match on the tier token appearing anywhere in
 * the id rather than the leading segment. Unknown ids resolve to
 * {@link DEFAULT_FAMILY}.
 */
export function claudeModelFamily(modelId: string): string {
  const id = modelId.toLowerCase()
  if (id.includes('fable')) return 'claude-fable'
  if (id.includes('opus')) return 'claude-opus'
  if (id.includes('sonnet')) return 'claude-sonnet'
  if (id.includes('haiku')) return 'claude-haiku'
  return DEFAULT_FAMILY
}

export function claudeModelPricing(modelId: string): ClaudeModelPricing {
  return PRICING[claudeModelFamily(modelId)] ?? DEFAULT_PRICING
}

/** Estimated USD cost for one model's accumulated token tally. */
export function estimateClaudeCostUSD(modelId: string, tally: ClaudeTokenTally): number {
  const p = claudeModelPricing(modelId)
  return (
    (tally.inputTokens * p.input +
      tally.cacheCreateTokens * p.cacheWrite +
      tally.cacheReadTokens * p.cacheRead +
      tally.outputTokens * p.output) /
    1_000_000
  )
}
