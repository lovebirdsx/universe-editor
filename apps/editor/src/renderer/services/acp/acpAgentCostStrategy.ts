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
import { extractCodexModelUsage, extractCodexTurnUsage } from '../../../shared/ai/codexPricing.js'
import { estimateCodexCost, type CodexCostEstimate } from './acpSessionCost.js'

/**
 * Locally estimates a session's cost when the agent reports none. Both hooks
 * return the same estimate shape; `undefined` means "nothing to price" and the
 * session falls back to the agent's own (authoritative or carried-forward) cost.
 */
export interface AcpAgentCostStrategy {
  /** Estimate from a `usage_update`'s `_meta` (session-cumulative per-model tokens). */
  fromUsageUpdate(meta: unknown): CodexCostEstimate | undefined
  /** Estimate from a turn-final `PromptResponse` (confirms the final total). */
  fromPromptResponse(response: PromptResponse): CodexCostEstimate | undefined
}

const CODEX_COST_STRATEGY: AcpAgentCostStrategy = {
  fromUsageUpdate: (meta) => estimateCodexCost(extractCodexModelUsage(meta)),
  fromPromptResponse: (response) => estimateCodexCost(extractCodexTurnUsage(response)),
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
