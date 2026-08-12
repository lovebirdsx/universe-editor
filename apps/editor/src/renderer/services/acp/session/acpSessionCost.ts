/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Session-cost estimation for AcpSession. Codex never reports an authoritative
 *  cost, so we price the session-cumulative per-model token counts the fork
 *  stamps on usage_update / PromptResponse. Claude reports a cost, but the CLI
 *  prices it against an Anthropic-only catalog — sessions running gateway models
 *  (kimi/deepseek/…) get inflated figures and are re-priced locally instead.
 *  Pure + vendor-specific, kept out of the main session class so the
 *  cost-estimation logic can be unit-tested in isolation.
 *--------------------------------------------------------------------------------------------*/

import { estimateCodexCostUSD, type CodexModelUsage } from '../../../../shared/ai/codexPricing.js'
import { claudeModelFamily, estimateClaudeCostUSD } from '../../../../shared/ai/claudePricing.js'
import type { AcpModelCost } from './acpSessionModel.js'

export interface SessionCostEstimate {
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
): SessionCostEstimate | undefined {
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

/**
 * Re-price a Claude-side per-model breakdown whose costUSD figures came from the
 * Claude CLI's own pricing catalog. That catalog only knows Anthropic tiers and
 * silently bills gateway models it doesn't recognise (kimi/deepseek/…) at the
 * default flagship rate, so the "authoritative" total is inflated for those
 * sessions. When any row resolves outside the claude family, foreign rows are
 * re-priced from their token counts against our gateway pricing table (claude
 * rows keep the CLI's figure, which is correct for them) and the session total
 * is re-aggregated. Returns undefined for pure-claude breakdowns — the CLI cost
 * stays authoritative there.
 */
export function repriceForeignModelBreakdown(
  models: readonly AcpModelCost[],
): SessionCostEstimate | undefined {
  if (models.length === 0) return undefined
  let sawForeign = false
  const out: AcpModelCost[] = []
  let totalUsd = 0
  for (const m of models) {
    const foreign = !claudeModelFamily(m.model).startsWith('claude-')
    sawForeign ||= foreign
    const costUSD = foreign
      ? estimateClaudeCostUSD(m.model, {
          inputTokens: m.inputTokens,
          cacheCreateTokens: m.cacheCreateTokens,
          cacheReadTokens: m.cacheReadTokens,
          outputTokens: m.outputTokens,
        })
      : m.costUSD
    totalUsd += costUSD
    out.push(costUSD === m.costUSD ? m : { ...m, costUSD })
  }
  if (!sawForeign) return undefined
  return { cost: { amount: totalUsd, currency: 'USD' }, models: out }
}
