/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Per-agent cost-estimation strategy. Collapses the scattered
 *  `agentId === 'codex'` cost branches in AcpSession into a single descriptor
 *  lookup: an agent either reports authoritative cost (Claude — no strategy) or
 *  needs the editor to estimate it locally from token counts (Codex). New agents
 *  that need local pricing register a strategy here instead of growing another
 *  inline `agentId ===` branch in the session class.
 *--------------------------------------------------------------------------------------------*/

import type { PromptResponse } from '@agentclientprotocol/sdk'
import { extractCodexModelUsage, extractCodexTurnUsage } from '../../../../shared/ai/codexUsage.js'
import { estimateCodexCost, type SessionCostEstimate } from './acpSessionCost.js'
import type { SessionProviderContext } from './acpSessionProviderContext.js'

/**
 * Locally estimates a session's cost when the agent reports none. Both hooks
 * return the same estimate shape; `undefined` means "nothing to price" and the
 * session falls back to the agent's own (authoritative or carried-forward) cost.
 * `ctx` is the session's provider context (agentId-resolved); absent it degrades
 * to the built-in catalog.
 */
export interface AcpAgentCostStrategy {
  /** Estimate from a `usage_update`'s `_meta` (session-cumulative per-model tokens). */
  fromUsageUpdate(meta: unknown, ctx?: SessionProviderContext): SessionCostEstimate | undefined
  /** Estimate from a turn-final `PromptResponse` (confirms the final total). */
  fromPromptResponse(
    response: PromptResponse,
    ctx?: SessionProviderContext,
  ): SessionCostEstimate | undefined
}

const CODEX_COST_STRATEGY: AcpAgentCostStrategy = {
  fromUsageUpdate: (meta, ctx) => estimateCodexCost(extractCodexModelUsage(meta), ctx),
  fromPromptResponse: (response, ctx) => estimateCodexCost(extractCodexTurnUsage(response), ctx),
}

const STRATEGIES: Readonly<Record<string, AcpAgentCostStrategy>> = {
  codex: CODEX_COST_STRATEGY,
}

/**
 * The local cost-estimation strategy for an agent, or `undefined` when the agent
 * reports authoritative cost itself (Claude) and needs no local estimate.
 */
export function getAgentCostStrategy(agentId: string): AcpAgentCostStrategy | undefined {
  return STRATEGIES[agentId]
}
