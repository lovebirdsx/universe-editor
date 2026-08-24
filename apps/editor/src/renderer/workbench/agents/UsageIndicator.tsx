/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  UsageIndicator — the usage readout in PromptInput's action row, right of the
 *  session timer. Which readout it shows depends on how the session's agent is
 *  authenticated (see `resolveUsageDisplay`):
 *
 *   - an official subscription (claude.ai Pro/Max, ChatGPT Plus/Pro) reports
 *     rate-limit windows, so the collapsed form is the tightest window's used
 *     percentage — matching what the vendors' own clients show — and the popover
 *     breaks every window down with a bar and a reset time. Codex additionally
 *     offers redeeming a rate-limit reset credit from there.
 *   - a provider-declared account usage source shows the authoritative account
 *     number (quota / balance / subscription).
 *   - anything else hides the indicator.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CircleAlert, Gauge, RefreshCw, TimerReset, Wallet } from 'lucide-react'
import {
  constObservable,
  generateUuid,
  IDialogService,
  INotificationService,
  localize,
  Severity,
  type AiAccountUsage,
} from '@universe-editor/platform'
import { useObservable, useOptionalService, useService } from '../useService.js'
import {
  ISubscriptionUsageService,
  type ResetCreditOutcome,
} from '../../services/usage/SubscriptionUsageService.js'
import { IAccountUsageService } from '../../services/usage/AccountUsageService.js'
import {
  pickTightestWindow,
  resolveUsageDisplay,
  type AccountUsageState,
  type SubscriptionUsageSnapshot,
  type SubscriptionUsageWindow,
} from '../../services/usage/subscriptionUsage.js'
import type { IAcpSession } from '../../services/acp/session/acpSessionService.js'
import styles from './agents.module.css'

/** Stable fallbacks so the hooks below stay unconditional when a service is absent. */
const NO_SNAPSHOT = constObservable<SubscriptionUsageSnapshot | undefined>(undefined)
const NO_ACCOUNT = constObservable<AccountUsageState>({ hasSource: false })

/** How often the component re-evaluates staleness while nothing else changes. */
const STALE_RECHECK_MS = 30_000

function formatPercent(value: number): string {
  return `${Math.round(value)}%`
}

function formatAbsolute(epochMs: number): string {
  return new Date(epochMs).toLocaleString()
}

function accountSymbol(usage: AiAccountUsage): string {
  return usage.currency === 'CNY' ? '¥' : '$'
}

function accountMoney(value: number, usage: AiAccountUsage): string {
  return `${accountSymbol(usage)}${value.toFixed(2)}`
}

/** The single collapsed figure: remaining when reported, else used (over limit). */
function accountPrimaryLabel(usage: AiAccountUsage): string {
  if (usage.remainingUSD !== undefined) return accountMoney(usage.remainingUSD, usage)
  if (usage.usedUSD !== undefined) {
    return usage.limitUSD !== undefined
      ? `${accountMoney(usage.usedUSD, usage)} / ${accountMoney(usage.limitUSD, usage)}`
      : accountMoney(usage.usedUSD, usage)
  }
  return '—'
}

function accountKindLabel(usage: AiAccountUsage): string {
  switch (usage.kind) {
    case 'quota':
      return localize('acp.accountUsage.kind.quota', 'Quota')
    case 'balance':
      return localize('acp.accountUsage.kind.balance', 'Balance')
    case 'subscription':
      return localize('acp.accountUsage.kind.subscription', 'Subscription')
  }
}

/** "in 3h 20m" / "in 12m" while the window is still open, an absolute time once it is far out. */
function formatResetsAt(epochMs: number, now: number): string {
  const deltaMs = epochMs - now
  if (deltaMs <= 0) return localize('acp.subscriptionUsage.resetsNow', 'resetting now')
  const minutes = Math.round(deltaMs / 60_000)
  if (minutes < 1) return localize('acp.subscriptionUsage.resetsNow', 'resetting now')
  if (minutes < 60) {
    return localize('acp.subscriptionUsage.resetsInMinutes', 'resets in {minutes}m', { minutes })
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    const rest = minutes % 60
    return rest === 0
      ? localize('acp.subscriptionUsage.resetsInHours', 'resets in {hours}h', { hours })
      : localize('acp.subscriptionUsage.resetsInHoursMinutes', 'resets in {hours}h {minutes}m', {
          hours,
          minutes: rest,
        })
  }
  return localize('acp.subscriptionUsage.resetsAt', 'resets {at}', { at: formatAbsolute(epochMs) })
}

export function UsageIndicator({ session }: { session: IAcpSession }) {
  const agentId = session.agentId
  const subscription = useOptionalService(ISubscriptionUsageService)
  const account = useOptionalService(IAccountUsageService)

  const snapshotObservable = useMemo(
    () => subscription?.snapshotFor(agentId) ?? NO_SNAPSHOT,
    [subscription, agentId],
  )
  const snapshot = useObservable(snapshotObservable)

  const accountObservable = useMemo(
    () => account?.stateFor(agentId) ?? NO_ACCOUNT,
    [account, agentId],
  )
  const accountState = useObservable(accountObservable)

  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  // Without a live agent connection nothing pushes a new snapshot, so the "is it
  // still fresh?" answer has to be recomputed on our own clock.
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), STALE_RECHECK_MS)
    return () => clearInterval(timer)
  }, [])

  useEffect(() => {
    void subscription?.refresh(agentId)
    void account?.refresh(agentId)
  }, [subscription, account, agentId])

  const display = resolveUsageDisplay({
    snapshot,
    account: accountState,
  })

  if (display === 'hidden') return null

  if (display === 'account' || display === 'unavailable') {
    const forceRefresh = () => void account?.refresh(agentId, { force: true })
    if (display === 'account' && accountState.usage !== undefined) {
      return (
        <AccountIndicator
          agentId={agentId}
          usage={accountState.usage}
          onForceRefresh={forceRefresh}
        />
      )
    }
    return <UnavailableIndicator onForceRefresh={forceRefresh} />
  }

  // `display === 'subscription'` implies a snapshot exists.
  const usage = snapshot as SubscriptionUsageSnapshot
  const tightest = pickTightestWindow(usage)
  const stale = subscription?.isStale(usage, now) === true

  const tooltip = stale
    ? localize(
        'acp.subscriptionUsage.indicator.stale',
        'Subscription usage as of {at} — click for details',
        { at: formatAbsolute(usage.fetchedAt) },
      )
    : localize('acp.subscriptionUsage.indicator', 'Subscription usage — click for details')

  return (
    <div className={styles['usageWrap']}>
      <button
        type="button"
        className={styles['usageIndicator']}
        data-state="ok"
        data-stale={stale ? 'true' : undefined}
        data-tooltip={tooltip}
        onClick={() => {
          if (!open) void subscription?.refresh(agentId, { force: true })
          setNow(Date.now())
          setOpen((v) => !v)
        }}
        data-testid="acp-usage-indicator"
      >
        <Gauge size={13} strokeWidth={1.75} aria-hidden="true" />
        <span className={styles['usageIndicatorText']}>
          {tightest === undefined ? '—' : formatPercent(tightest.usedPercent)}
        </span>
      </button>
      {open ? (
        <SubscriptionUsagePopover
          agentId={agentId}
          snapshot={usage}
          stale={stale}
          now={now}
          onDismiss={() => setOpen(false)}
        />
      ) : null}
    </div>
  )
}

/** Close on an outside click or Escape — shared by both popovers. */
function useDismissOnOutside(onDismiss: () => void) {
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

  return containerRef
}

function AccountIndicator({
  agentId,
  usage,
  onForceRefresh,
}: {
  agentId: string
  usage: AiAccountUsage
  onForceRefresh: () => void
}) {
  const [open, setOpen] = useState(false)

  return (
    <div className={styles['usageWrap']}>
      <button
        type="button"
        className={styles['usageIndicator']}
        data-state="ok"
        data-tooltip={localize('acp.accountUsage.indicator', 'Account usage — click for details')}
        onClick={() => {
          if (!open) onForceRefresh()
          setOpen((v) => !v)
        }}
        data-testid="acp-usage-indicator"
      >
        <Wallet size={13} strokeWidth={1.75} aria-hidden="true" />
        <span className={styles['usageIndicatorText']}>{accountPrimaryLabel(usage)}</span>
      </button>
      {open ? (
        <AccountUsagePopover agentId={agentId} usage={usage} onDismiss={() => setOpen(false)} />
      ) : null}
    </div>
  )
}

function UnavailableIndicator({ onForceRefresh }: { onForceRefresh: () => void }) {
  return (
    <button
      type="button"
      className={styles['usageIndicator']}
      data-state="unavailable"
      data-tooltip={localize(
        'acp.accountUsage.unavailable.tooltip',
        'This provider declares an account usage source, but the authoritative number is not available right now. Local estimates are never shown here.',
      )}
      onClick={onForceRefresh}
      data-testid="acp-usage-indicator"
    >
      <CircleAlert size={13} strokeWidth={1.75} aria-hidden="true" />
      <span className={styles['usageIndicatorText']}>
        {localize('acp.accountUsage.unavailable', 'Unavailable')}
      </span>
    </button>
  )
}

function AccountUsagePopover({
  agentId,
  usage,
  onDismiss,
}: {
  agentId: string
  usage: AiAccountUsage
  onDismiss: () => void
}) {
  const containerRef = useDismissOnOutside(onDismiss)
  const account = useService(IAccountUsageService)
  const [refreshing, setRefreshing] = useState(false)
  const now = Date.now()

  const refreshNow = useCallback(async () => {
    setRefreshing(true)
    try {
      await account.refresh(agentId, { force: true })
    } finally {
      setRefreshing(false)
    }
  }, [account, agentId])

  return (
    <div
      ref={containerRef}
      className={styles['sessionCostPopover']}
      data-testid="acp-usage-popover"
      role="dialog"
      aria-label={localize('acp.accountUsage.popover', 'Account usage')}
    >
      <div className={styles['sessionCostHeader']}>
        <span>{accountKindLabel(usage)}</span>
        <span className={styles['sessionCostTotal']}>{accountPrimaryLabel(usage)}</span>
      </div>

      {usage.usedUSD !== undefined ? (
        <div className={styles['sessionCostFooter']} style={{ marginTop: 0, borderTop: 'none' }}>
          {localize('acp.accountUsage.used', 'Used: {amount}', {
            amount: accountMoney(usage.usedUSD, usage),
          })}
        </div>
      ) : null}
      {usage.limitUSD !== undefined ? (
        <div className={styles['sessionCostFooter']} style={{ marginTop: 0, borderTop: 'none' }}>
          {localize('acp.accountUsage.limit', 'Limit: {amount}', {
            amount: accountMoney(usage.limitUSD, usage),
          })}
        </div>
      ) : null}
      {usage.remainingUSD !== undefined ? (
        <div className={styles['sessionCostFooter']} style={{ marginTop: 0, borderTop: 'none' }}>
          {localize('acp.accountUsage.remaining', 'Remaining: {amount}', {
            amount: accountMoney(usage.remainingUSD, usage),
          })}
        </div>
      ) : null}

      {usage.windows !== undefined && usage.windows.length > 0
        ? usage.windows.map((window) => (
            <UsageWindowRow key={window.id} window={window} now={now} />
          ))
        : null}

      <div className={styles['usageResetRow']}>
        <span>
          {localize('acp.accountUsage.fetchedAt', 'Updated {at}', {
            at: formatAbsolute(usage.fetchedAt),
          })}
        </span>
        <button
          type="button"
          className={styles['usageResetButton']}
          disabled={refreshing}
          onClick={() => void refreshNow()}
          data-testid="acp-account-refresh"
        >
          <RefreshCw size={12} strokeWidth={1.75} aria-hidden="true" />
          {localize('acp.accountUsage.refresh', 'Refresh')}
        </button>
      </div>
    </div>
  )
}

function SubscriptionUsagePopover({
  agentId,
  snapshot,
  stale,
  now,
  onDismiss,
}: {
  agentId: string
  snapshot: SubscriptionUsageSnapshot
  stale: boolean
  now: number
  onDismiss: () => void
}) {
  const containerRef = useDismissOnOutside(onDismiss)
  const subscription = useService(ISubscriptionUsageService)
  const dialog = useService(IDialogService)
  const notification = useService(INotificationService)
  const [redeeming, setRedeeming] = useState(false)

  const availableCredits = snapshot.resetCredits?.availableCount ?? 0

  const redeem = useCallback(async () => {
    const result = await dialog.confirm({
      type: 'warning',
      message: localize('acp.subscriptionUsage.reset.confirm', 'Redeem a rate-limit reset credit?'),
      detail: localize(
        'acp.subscriptionUsage.reset.confirmDetail',
        'This consumes one of your {count} available credits and cannot be undone.',
        { count: availableCredits },
      ),
      primaryButton: localize('acp.subscriptionUsage.reset.confirmButton', 'Redeem'),
    })
    if (!result.confirmed) return

    // One user confirmation = one key. A retry of this same attempt must reuse it,
    // or the retry burns a second credit.
    const idempotencyKey = generateUuid()
    setRedeeming(true)
    let outcome: ResetCreditOutcome
    try {
      outcome = await subscription.consumeResetCredit(agentId, idempotencyKey)
    } finally {
      setRedeeming(false)
    }
    notification.notify(resetCreditNotification(outcome))
  }, [agentId, availableCredits, dialog, notification, subscription])

  return (
    <div
      ref={containerRef}
      className={styles['sessionCostPopover']}
      data-testid="acp-usage-popover"
      role="dialog"
      aria-label={localize('acp.subscriptionUsage.popover', 'Subscription usage breakdown')}
    >
      <div className={styles['sessionCostHeader']}>
        <span>
          {snapshot.planLabel === undefined
            ? localize('acp.subscriptionUsage.popover.title', 'Subscription usage')
            : localize('acp.subscriptionUsage.popover.titlePlan', 'Subscription usage · {plan}', {
                plan: snapshot.planLabel,
              })}
        </span>
      </div>

      {snapshot.windows.length === 0 ? (
        <div className={styles['sessionCostEmpty']}>
          {localize('acp.subscriptionUsage.noWindows', 'No rate-limit windows reported.')}
        </div>
      ) : (
        snapshot.windows.map((window) => (
          <UsageWindowRow key={window.id} window={window} now={now} />
        ))
      )}

      {snapshot.extraUsage?.enabled === true ? (
        <div className={styles['sessionCostFooter']} style={{ marginTop: 6 }}>
          {snapshot.extraUsage.usedCredits === undefined
            ? localize('acp.subscriptionUsage.extraUsage', 'Extra usage: on')
            : localize(
                'acp.subscriptionUsage.extraUsageSpend',
                'Extra usage: {used} / {limit} {currency}',
                {
                  used: snapshot.extraUsage.usedCredits,
                  limit: snapshot.extraUsage.monthlyLimit ?? '—',
                  currency: snapshot.extraUsage.currency ?? '',
                },
              )}
        </div>
      ) : null}

      {snapshot.resetCredits !== undefined ? (
        <div className={styles['usageResetRow']}>
          <span>
            {localize('acp.subscriptionUsage.resetCredits', 'Reset credits: {count}', {
              count: availableCredits,
            })}
          </span>
          <button
            type="button"
            className={styles['usageResetButton']}
            disabled={availableCredits <= 0 || redeeming}
            onClick={() => void redeem()}
            data-testid="acp-usage-reset-credit"
          >
            <TimerReset size={12} strokeWidth={1.75} aria-hidden="true" />
            {localize('acp.subscriptionUsage.reset.action', 'Reset limit')}
          </button>
        </div>
      ) : null}

      <div className={styles['sessionCostFooter']} data-stale={stale ? 'true' : undefined}>
        {stale
          ? localize('acp.subscriptionUsage.staleFooter', 'Data as of {at} (no live session)', {
              at: formatAbsolute(snapshot.fetchedAt),
            })
          : localize('acp.subscriptionUsage.freshFooter', 'Updated {at}', {
              at: formatAbsolute(snapshot.fetchedAt),
            })}
      </div>
    </div>
  )
}

function UsageWindowRow({ window, now }: { window: SubscriptionUsageWindow; now: number }) {
  return (
    <div className={styles['usageWindowRow']} data-testid="acp-usage-window">
      <div className={styles['usageWindowHead']}>
        <span className={styles['usageWindowLabel']}>{window.label}</span>
        <span className={styles['sessionCostTotal']}>{formatPercent(window.usedPercent)}</span>
      </div>
      <div className={styles['compactionProgress']} style={{ width: '100%', marginLeft: 0 }}>
        <span
          className={styles['compactionProgressFill']}
          style={{ width: `${Math.min(100, Math.max(0, window.usedPercent))}%` }}
        />
      </div>
      {window.resetsAt === undefined ? null : (
        <div className={styles['usageWindowReset']}>{formatResetsAt(window.resetsAt, now)}</div>
      )}
    </div>
  )
}

function resetCreditNotification(outcome: ResetCreditOutcome): {
  severity: Severity
  message: string
} {
  switch (outcome) {
    case 'reset':
      return {
        severity: Severity.Info,
        message: localize('acp.subscriptionUsage.reset.done', 'Rate limit reset.'),
      }
    // The credit was already spent on this attempt — treat it as success rather
    // than tempting the user into a second redemption.
    case 'alreadyRedeemed':
      return {
        severity: Severity.Info,
        message: localize(
          'acp.subscriptionUsage.reset.alreadyRedeemed',
          'That reset credit was already redeemed.',
        ),
      }
    case 'nothingToReset':
      return {
        severity: Severity.Info,
        message: localize(
          'acp.subscriptionUsage.reset.nothingToReset',
          'No rate limit is currently hit — nothing to reset.',
        ),
      }
    case 'noCredit':
      return {
        severity: Severity.Warning,
        message: localize(
          'acp.subscriptionUsage.reset.noCredit',
          'No reset credit is available on this account.',
        ),
      }
    case 'unavailable':
      return {
        severity: Severity.Warning,
        message: localize(
          'acp.subscriptionUsage.reset.unavailable',
          'No live agent session to redeem through — send a message first.',
        ),
      }
    case 'failed':
      return {
        severity: Severity.Error,
        message: localize('acp.subscriptionUsage.reset.failed', 'Failed to redeem the credit.'),
      }
  }
}
