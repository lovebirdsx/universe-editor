/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Parses the per-model token usage Codex stamps onto quota snapshots and turn
 *  responses. Token counts without a model name are bucketed under
 *  {@link CODEX_UNKNOWN_MODEL} so downstream can surface them as "rate unknown".
 *--------------------------------------------------------------------------------------------*/

import type { PromptResponse } from '@agentclientprotocol/sdk'

/** Bucket name for token counts a codex quota snapshot reports without a model. */
const UNKNOWN_MODEL = 'unknown'

export const CODEX_UNKNOWN_MODEL = UNKNOWN_MODEL

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
  const model = typeof r['model'] === 'string' ? r['model'] : UNKNOWN_MODEL
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
 * field under the unknown-model bucket when the quota meta is absent. Returns []
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
  return [{ model: UNKNOWN_MODEL, inputTokens, cachedReadTokens, outputTokens }]
}
