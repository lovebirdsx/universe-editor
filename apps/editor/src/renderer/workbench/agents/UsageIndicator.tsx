/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  UsageIndicator — compact account-level API usage readout shown in PromptInput's
 *  action row, right of the session timer. Subscribes to IApiUsageService; clicking
 *  the glyph triggers a (debounced) manual refresh. Hidden entirely when usage
 *  credentials are not configured.
 *--------------------------------------------------------------------------------------------*/

import { CircleAlert, Wallet } from 'lucide-react'
import { localize } from '@universe-editor/platform'
import { useOptionalService, useObservable } from '../useService.js'
import { IApiUsageService } from '../../services/usage/ApiUsageService.js'
import type { UsageSnapshot } from '../../../shared/ipc/services.js'
import styles from './agents.module.css'

function formatCny(raw: number, digits: number = 2): string {
  return (raw / 10000).toFixed(digits)
}

export function UsageIndicator() {
  const service = useOptionalService(IApiUsageService)
  if (!service) return null
  return <UsageIndicatorInner service={service} />
}

function UsageIndicatorInner({ service }: { service: IApiUsageService }) {
  const state = useObservable(service.state)

  if (state.kind === 'disabled') return null

  if (state.kind === 'error') {
    return (
      <button
        type="button"
        className={styles['usageIndicator']}
        data-state="error"
        title={localize('acp.usage.error', 'API usage unavailable: {reason}', {
          reason: state.message,
        })}
        onClick={() => service.refresh()}
        data-testid="acp-usage-indicator"
      >
        <CircleAlert size={13} strokeWidth={1.75} aria-hidden="true" />
      </button>
    )
  }

  if (state.kind === 'loading') {
    return (
      <button
        type="button"
        className={styles['usageIndicator']}
        data-state="loading"
        title={localize('acp.usage.loading', 'Loading API usage…')}
        onClick={() => service.refresh()}
        data-testid="acp-usage-indicator"
      >
        <Wallet size={13} strokeWidth={1.75} aria-hidden="true" />
      </button>
    )
  }

  const s = state.snapshot
  return (
    <button
      type="button"
      className={styles['usageIndicator']}
      data-state="ok"
      title={buildTooltip(s)}
      onClick={() => service.refresh()}
      data-testid="acp-usage-indicator"
    >
      <Wallet size={13} strokeWidth={1.75} aria-hidden="true" />
      <span className={styles['usageIndicatorText']}>¥{formatCny(s.periodUsedCny, 0)}</span>
    </button>
  )
}

function buildTooltip(s: UsageSnapshot): string {
  const pct = s.periodLimitCny > 0 ? ((s.periodUsedCny / s.periodLimitCny) * 100).toFixed(1) : '0.0'
  const lines: string[] = []
  lines.push(localize('acp.usage.title', '=== API Usage ({date}) ===', { date: s.date }))
  lines.push(localize('acp.usage.period', 'Period: {period}', { period: s.periodBucket }))
  lines.push(
    localize('acp.usage.usedTotal', 'Used: ¥{used} / Total: ¥{total}  ({pct}%)', {
      used: formatCny(s.periodUsedCny),
      total: formatCny(s.periodLimitCny),
      pct,
    }),
  )
  lines.push(
    localize('acp.usage.remaining', 'Remaining: ¥{remaining}', {
      remaining: formatCny(s.periodRemainingCny),
    }),
  )
  if (s.models.length > 0) {
    lines.push('')
    lines.push(localize('acp.usage.modelBreakdown', '--- Week by model ---'))
    for (const m of s.models) {
      lines.push(`  ${m.model}  ${m.requests} req  ¥${formatCny(m.costCny)}`)
    }
  }
  lines.push('')
  lines.push(
    localize('acp.usage.totals', 'Week total: {requests} req  Token: {tokens}', {
      requests: s.requests,
      tokens: s.rawTokens.toLocaleString(),
    }),
  )
  return lines.join('\n')
}
