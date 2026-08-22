/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Session-cost estimation for AcpSession. Codex never reports an authoritative
 *  cost, so we price the session-cumulative per-model token counts the fork
 *  stamps on usage_update / PromptResponse. Claude reports a cost, but the CLI
 *  prices it against an Anthropic-only catalog — sessions running gateway models
 *  (kimi/deepseek/…) get inflated figures and are re-priced locally instead.
 *
 *  Both estimators resolve a bare model id through `priceSessionModel` (the
 *  five-level chain: declared model → gateway table → type default → built-in
 *  catalog). A row that resolves to no rate contributes no cost — its `costUSD`
 *  stays `undefined` so the UI renders "—" rather than "free", and a total with
 *  no priced rows carries no cost. Pure + vendor-specific, kept out of the main
 *  session class so the cost-estimation logic can be unit-tested in isolation.
 *--------------------------------------------------------------------------------------------*/

import { estimateCostUSD } from '@universe-editor/platform'
import { isAnthropicCatalogModel } from '../../../../shared/ai/catalog/index.js'
import type { CodexModelUsage } from '../../../../shared/ai/codexUsage.js'
import { priceSessionModel, type SessionProviderContext } from './acpSessionProviderContext.js'
import type { AcpModelCost } from './acpSessionModel.js'

export interface SessionCostEstimate {
  /** Total USD; absent when no row resolved to a rate. */
  readonly cost?: { readonly amount: number; readonly currency: string }
  readonly models: AcpModelCost[]
}

/**
 * Price a snapshot of session-cumulative per-model Codex usage. Returns the
 * total cost plus the per-model breakdown, or undefined when there is nothing to
 * price. Token counts are cumulative (the fork reports a running total on every
 * model call), so callers overwrite rather than accumulate. Rows whose model
 * resolves to no rate keep `costUSD` unset and are not counted toward the total.
 */
export function estimateCodexCost(
  usages: readonly CodexModelUsage[],
  ctx?: SessionProviderContext,
): SessionCostEstimate | undefined {
  if (usages.length === 0) return undefined
  const models: AcpModelCost[] = []
  let totalUsd = 0
  let priced = false
  for (const u of usages) {
    const pricing = priceSessionModel(u.model, ctx).pricing
    const costUSD =
      pricing !== undefined
        ? estimateCostUSD(pricing, {
            input: u.inputTokens,
            output: u.outputTokens,
            cacheRead: u.cachedReadTokens,
          })
        : undefined
    if (costUSD !== undefined) {
      totalUsd += costUSD
      priced = true
    }
    models.push({
      model: u.model,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      cacheReadTokens: u.cachedReadTokens,
      cacheCreateTokens: 0,
      ...(costUSD !== undefined ? { costUSD } : {}),
    })
  }
  return {
    ...(priced ? { cost: { amount: totalUsd, currency: 'USD' } } : {}),
    models,
  }
}

/**
 * Re-price a Claude-side per-model breakdown whose costUSD figures came from the
 * Claude CLI's own pricing catalog. That catalog only knows Anthropic tiers and
 * silently bills gateway models it doesn't recognise (kimi/deepseek/…) at the
 * default flagship rate, so the "authoritative" total is inflated for those
 * sessions.
 *
 * Per-row judgement (exact catalog membership, no family guessing):
 *  - a rate the user or their gateway configured (`model` / `gateway` / `type`)
 *    always wins — it describes this deployment better than any catalog;
 *  - otherwise an Anthropic official model keeps the CLI's figure, which is
 *    authoritative for the models the CLI actually knows;
 *  - otherwise (a foreign gateway model) our catalog rate replaces the CLI's
 *    inflated one, or the row goes unpriced when nothing resolves.
 *
 * Returns undefined when no row changed — the CLI total stays authoritative.
 */
export function repriceForeignModelBreakdown(
  models: readonly AcpModelCost[],
  ctx?: SessionProviderContext,
): SessionCostEstimate | undefined {
  if (models.length === 0) return undefined
  const out: AcpModelCost[] = []
  let totalUsd = 0
  let repriced = false
  for (const m of models) {
    const { pricing, origin } = priceSessionModel(m.model, ctx)
    const configured = origin === 'model' || origin === 'gateway' || origin === 'type'
    const trustCli = !configured && isAnthropicCatalogModel(m.model)
    if (pricing !== undefined && !trustCli) {
      const costUSD = estimateCostUSD(pricing, {
        input: m.inputTokens,
        output: m.outputTokens,
        cacheRead: m.cacheReadTokens,
        cacheWrite: m.cacheCreateTokens,
      })
      totalUsd += costUSD
      repriced = true
      out.push({ ...m, costUSD })
    } else {
      totalUsd += m.costUSD ?? 0
      out.push(m)
    }
  }
  if (!repriced) return undefined
  return { cost: { amount: totalUsd, currency: 'USD' }, models: out }
}
