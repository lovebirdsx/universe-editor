/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Codex cost estimation for AcpSession. Codex never reports an authoritative
 *  cost, so we price the session-cumulative per-model token counts the fork
 *  stamps on usage_update / PromptResponse. Pure + vendor-specific, kept out of
 *  the main session class so the cost-estimation logic can be unit-tested in
 *  isolation and the Codex special-casing stays contained.
 *--------------------------------------------------------------------------------------------*/

import { estimateCodexCostUSD, type CodexModelUsage } from '../../../shared/ai/codexPricing.js'
import type { AcpModelCost } from './acpSessionModel.js'

export interface CodexCostEstimate {
  readonly cost: { readonly amount: number; readonly currency: string }
  readonly models: AcpModelCost[]
}

/**
 * Price a snapshot of session-cumulative per-model Codex usage. Returns the
 * total cost plus the per-model breakdown, or undefined when there is nothing to
 * price. Token counts are cumulative (the fork reports a running total on every
 * model call), so callers overwrite rather than accumulate.
 */
export function estimateCodexCost(
  usages: readonly CodexModelUsage[],
): CodexCostEstimate | undefined {
  if (usages.length === 0) return undefined
  const models: AcpModelCost[] = []
  let totalUsd = 0
  for (const u of usages) {
    const costUSD = estimateCodexCostUSD(u.model, {
      inputTokens: u.inputTokens,
      cachedReadTokens: u.cachedReadTokens,
      outputTokens: u.outputTokens,
    })
    totalUsd += costUSD
    models.push({
      model: u.model,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      cacheReadTokens: u.cachedReadTokens,
      cacheCreateTokens: 0,
      costUSD,
    })
  }
  return { cost: { amount: totalUsd, currency: 'USD' }, models }
}
