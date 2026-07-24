/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SubagentStatsBadge — a compact metadata line rendered on a sub-agent-spawning
 *  tool call's header (Task/Agent): model · run duration · ↑input ↓output tokens ·
 *  ≈¥cost. Every field is optional — the agent fork reports what it can (Claude:
 *  all four; codex: duration only), and each missing piece is simply omitted.
 *  Cost is a local token-based estimate (the agent reports no per-sub-agent cost),
 *  so it is always prefixed with ≈ and converted to CNY via the daily rate.
 *--------------------------------------------------------------------------------------------*/

import { Bot, Clock, Coins } from 'lucide-react'
import type {
  AcpSubagentStats,
  AcpToolCall,
  AcpToolCallStatus,
} from '../../services/acp/acpSessionService.js'
import { useElapsedTime } from './elapsedTime.js'
import { useUsdToCnyRate } from './useExchangeRate.js'
import { formatCny, formatTokens } from './SessionCostIndicator.js'
import styles from './agents.module.css'

const FALLBACK_RATE = 7.2

export function SubagentStatsBadge({ call }: { call: AcpToolCall }) {
  const rate = useUsdToCnyRate()
  const stats = call.subagentStats
  const duration = useRunDuration(call.status, call.startedAt, call.durationMs)

  // Nothing worth showing: no stats and no duration.
  if (stats === undefined && duration === null) return null

  const model = stats?.model !== undefined ? shortModelName(stats.model) : undefined
  const tokens = stats !== undefined ? tokenSummary(stats) : undefined
  const costCny =
    stats?.costUSD !== undefined && stats.costUSD > 0
      ? stats.costUSD * (rate?.rate ?? FALLBACK_RATE)
      : undefined

  return (
    <span className={styles['subagentStats']} data-testid="acp-subagent-stats">
      {model !== undefined && (
        <span className={styles['subagentStatItem']} title={stats?.model}>
          <Bot size={11} strokeWidth={1.75} aria-hidden="true" />
          {model}
        </span>
      )}
      {duration !== null && (
        <span className={styles['subagentStatItem']}>
          <Clock size={11} strokeWidth={1.75} aria-hidden="true" />
          {duration}
        </span>
      )}
      {tokens !== undefined && <span className={styles['subagentStatItem']}>{tokens}</span>}
      {costCny !== undefined && (
        <span className={styles['subagentStatItem']} title="本地按 token 估算，实际计费可能不同">
          <Coins size={11} strokeWidth={1.75} aria-hidden="true" />
          ≈¥{formatCny(costCny)}
        </span>
      )}
    </span>
  )
}

/**
 * Live stopwatch while the tool call runs, frozen at `durationMs` once settled.
 * Returns null when there's no wall-clock anchor (e.g. history replay).
 */
function useRunDuration(
  status: AcpToolCallStatus,
  startedAt: number | undefined,
  durationMs: number | undefined,
): string | null {
  return useElapsedTime(status === 'pending' || status === 'in_progress', startedAt, durationMs)
}

function tokenSummary(stats: AcpSubagentStats): string | undefined {
  const input = stats.inputTokens + stats.cacheReadTokens + stats.cacheCreateTokens
  const output = stats.outputTokens
  if (input + output === 0) return undefined
  return `↑${formatTokens(input)} ↓${formatTokens(output)}`
}

/** Trim a provider model id to its recognizable family. */
function shortModelName(id: string): string {
  return id.replace(/-\d{8}$/, '').replace(/^claude-/, '')
}
