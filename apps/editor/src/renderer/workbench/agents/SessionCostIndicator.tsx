/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SessionCostIndicator — shows the running CNY cost of the current session next
 *  to the timer in PromptInput's action row. Clicking opens a popover that breaks
 *  the cost down by model (sub-agent / Task work is folded into each model's row
 *  by the agent). Cost figures are the agent's own authoritative USD numbers,
 *  converted to CNY via the daily exchange rate; hidden until the agent reports
 *  any cost.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useRef, useState } from 'react'
import { Wallet } from 'lucide-react'
import { localize } from '@universe-editor/platform'
import { useObservable } from '../useService.js'
import type { IAcpSession } from '../../services/acp/acpSessionService.js'
import type { AcpModelCost, AcpUsage } from '../../services/acp/acpSession.js'
import { useUsdToCnyRate } from './useExchangeRate.js'
import styles from './agents.module.css'

export function SessionCostIndicator({ session }: { session: IAcpSession }) {
  const usage = useObservable(session.usage)
  const rate = useUsdToCnyRate()
  const [open, setOpen] = useState(false)

  const totalUsd = usage?.cost?.amount
  if (usage == null || totalUsd == null || totalUsd <= 0) return null

  const estimated = usage.costEstimated === true
  const rateValue = rate?.rate ?? FALLBACK_RATE
  const totalCny = totalUsd * rateValue

  return (
    <div className={styles['sessionCostWrap']}>
      <button
        type="button"
        className={styles['usageIndicator']}
        title={
          estimated
            ? localize(
                'acp.cost.indicator.estimated',
                'Estimated session cost — click for breakdown',
              )
            : localize('acp.cost.indicator', 'Session cost — click for breakdown')
        }
        onClick={() => setOpen((v) => !v)}
        data-testid="acp-session-cost-indicator"
      >
        <Wallet size={13} strokeWidth={1.75} aria-hidden="true" />
        <span className={styles['usageIndicatorText']}>
          {estimated ? '≈' : ''}¥{formatCny(totalCny)}
        </span>
      </button>
      {open ? (
        <SessionCostPopover
          usage={usage}
          rate={rateValue}
          rateSource={rate?.source ?? 'fallback'}
          totalUsd={totalUsd}
          totalCny={totalCny}
          estimated={estimated}
          onDismiss={() => setOpen(false)}
        />
      ) : null}
    </div>
  )
}

function SessionCostPopover({
  usage,
  rate,
  rateSource,
  totalUsd,
  totalCny,
  estimated,
  onDismiss,
}: {
  usage: AcpUsage
  rate: number
  rateSource: 'live' | 'fallback'
  totalUsd: number
  totalCny: number
  estimated: boolean
  onDismiss: () => void
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const currency = usage.cost?.currency ?? 'USD'
  const models = usage.models ?? []

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

  return (
    <div
      ref={containerRef}
      className={styles['sessionCostPopover']}
      data-testid="acp-session-cost-popover"
      role="dialog"
      aria-label={localize('acp.cost.popover', 'Session cost breakdown')}
    >
      <div className={styles['sessionCostHeader']}>
        <span>
          {estimated
            ? localize('acp.cost.title.estimated', 'Estimated Session Cost')
            : localize('acp.cost.title', 'Session Cost')}
        </span>
        <span className={styles['sessionCostTotal']}>
          {estimated ? '≈' : ''}¥{formatCny(totalCny)}
        </span>
      </div>
      {models.length > 0 ? (
        <table className={styles['sessionCostTable']}>
          <thead>
            <tr>
              <th>{localize('acp.cost.col.model', 'Model')}</th>
              <th>{localize('acp.cost.col.input', 'Input')}</th>
              <th>{localize('acp.cost.col.output', 'Output')}</th>
              <th>{localize('acp.cost.col.cost', 'Cost')}</th>
            </tr>
          </thead>
          <tbody>
            {models.map((m) => (
              <ModelRow key={m.model} model={m} rate={rate} />
            ))}
          </tbody>
        </table>
      ) : (
        <div className={styles['sessionCostEmpty']}>
          {localize('acp.cost.noBreakdown', 'No per-model breakdown reported.')}
        </div>
      )}
      <div className={styles['sessionCostFooter']}>
        {localize('acp.cost.rate', 'Total {currency} {usd} · rate 1 USD = ¥{rate}{fallback}', {
          currency,
          usd: totalUsd.toFixed(4),
          rate: rate.toFixed(2),
          fallback:
            rateSource === 'fallback'
              ? localize('acp.cost.rateFallback', ' (offline estimate)')
              : '',
        })}
      </div>
      {estimated ? (
        <div className={styles['sessionCostFooter']}>
          {localize(
            'acp.cost.estimateNote',
            'Estimated locally from token usage — actual billing may differ.',
          )}
        </div>
      ) : null}
    </div>
  )
}

function ModelRow({ model, rate }: { model: AcpModelCost; rate: number }) {
  const inputTotal = model.inputTokens + model.cacheReadTokens + model.cacheCreateTokens
  return (
    <tr>
      <td className={styles['sessionCostModelName']} title={model.model}>
        {shortModelName(model.model)}
      </td>
      <td>{formatTokens(inputTotal)}</td>
      <td>{formatTokens(model.outputTokens)}</td>
      <td>¥{formatCny(model.costUSD * rate)}</td>
    </tr>
  )
}

/** Default rate used only before the async rate arrives; main owns the real fallback. */
const FALLBACK_RATE = 7.2

export function formatCny(value: number): string {
  // Codex estimates for cheap models (e.g. mini, cache-heavy turns) land in the
  // few-fen range; 1-decimal rounding would collapse them to ¥0.0. Widen the
  // precision for sub-¥1 amounts so they stay legible, while keeping larger
  // totals compact.
  if (value > 0 && value < 0.01) return '<0.01'
  if (value < 1) return value.toFixed(2)
  return value.toFixed(1)
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

/** Trim a provider model id to its recognizable family for the table. */
function shortModelName(id: string): string {
  return id.replace(/-\d{8}$/, '').replace(/^claude-/, '')
}
