/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  UsageIndicator — compact account-level API usage readout shown in PromptInput's
 *  action row, right of the session timer. Subscribes to IApiUsageService; clicking
 *  opens a popover with detailed breakdown and triggers a manual refresh. Hidden
 *  entirely when usage credentials are not configured.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useRef, useState } from 'react'
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
  const [open, setOpen] = useState(false)

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
    <div className={styles['usageWrap']}>
      <button
        type="button"
        className={styles['usageIndicator']}
        data-state="ok"
        title={localize('acp.usage.indicator', 'API monthly usage — click for breakdown')}
        onClick={() => {
          if (!open) service.refresh()
          setOpen((v) => !v)
        }}
        data-testid="acp-usage-indicator"
      >
        <Wallet size={13} strokeWidth={1.75} aria-hidden="true" />
        <span className={styles['usageIndicatorText']}>¥{formatCny(s.periodUsedCny, 0)}</span>
      </button>
      {open ? <UsagePopover snapshot={s} onDismiss={() => setOpen(false)} /> : null}
    </div>
  )
}

function UsagePopover({
  snapshot: s,
  onDismiss,
}: {
  snapshot: UsageSnapshot
  onDismiss: () => void
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const handlePointer = (ev: MouseEvent) => {
      const el = containerRef.current
      if (!el) return
      if (ev.target instanceof Node && el.contains(ev.target)) return
      onDismiss()
    }
    const handleKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') onDismiss()
    }
    const raf = requestAnimationFrame(() => {
      document.addEventListener('mousedown', handlePointer)
      document.addEventListener('keydown', handleKey)
    })
    return () => {
      cancelAnimationFrame(raf)
      document.removeEventListener('mousedown', handlePointer)
      document.removeEventListener('keydown', handleKey)
    }
  }, [onDismiss])

  const pct = s.periodLimitCny > 0 ? ((s.periodUsedCny / s.periodLimitCny) * 100).toFixed(1) : '0.0'

  return (
    <div
      ref={containerRef}
      className={styles['sessionCostPopover']}
      data-testid="acp-usage-popover"
      role="dialog"
      aria-label={localize('acp.usage.popover', 'API weekly usage breakdown')}
    >
      <div className={styles['sessionCostHeader']}>
        <span>
          {localize('acp.usage.popover.title', 'API Weekly Usage ({date})', { date: s.date })}
        </span>
        <span className={styles['sessionCostTotal']}>¥{formatCny(s.periodUsedCny, 0)}</span>
      </div>
      <div className={styles['sessionCostFooter']} style={{ marginTop: 0, borderTop: 'none' }}>
        {localize('acp.usage.period', 'Period: {period}', { period: s.periodBucket })}
      </div>
      <div className={styles['sessionCostFooter']} style={{ marginTop: 0, borderTop: 'none' }}>
        {localize('acp.usage.usedTotal', 'Used: ¥{used} / Total: ¥{total}  ({pct}%)', {
          used: formatCny(s.periodUsedCny),
          total: formatCny(s.periodLimitCny),
          pct,
        })}
      </div>
      <div className={styles['sessionCostFooter']} style={{ marginTop: 0, borderTop: 'none' }}>
        {localize('acp.usage.remaining', 'Remaining: ¥{remaining}', {
          remaining: formatCny(s.periodRemainingCny),
        })}
      </div>
      {s.models.length > 0 ? (
        <table className={styles['sessionCostTable']} style={{ marginTop: 6 }}>
          <thead>
            <tr>
              <th>{localize('acp.usage.col.model', 'Model')}</th>
              <th>{localize('acp.usage.col.requests', 'Requests')}</th>
              <th>{localize('acp.usage.col.cost', 'Cost')}</th>
            </tr>
          </thead>
          <tbody>
            {s.models.map((m) => (
              <tr key={m.model}>
                <td className={styles['sessionCostModelName']} title={m.model}>
                  {m.model}
                </td>
                <td>{m.requests}</td>
                <td>¥{formatCny(m.costCny)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <div className={styles['sessionCostEmpty']}>
          {localize('acp.usage.noBreakdown', 'No per-model breakdown available.')}
        </div>
      )}
      <div className={styles['sessionCostFooter']}>
        {localize('acp.usage.totals', 'Week total: {requests} req · {tokens} tokens', {
          requests: s.requests,
          tokens: s.rawTokens.toLocaleString(),
        })}
      </div>
    </div>
  )
}
