/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  usageFormat — turning an AiAccountUsage into the short strings the card shows.
 *
 *  These live outside the view because the same numbers appear in two places with
 *  two budgets: a header badge that must fit beside three others, and a detail
 *  line inside the usage section. Both must agree, and neither may invent a value
 *  — an absent number renders as an em dash, never as a zero or an estimate.
 *--------------------------------------------------------------------------------------------*/

import { localize, type AiAccountUsage } from '@universe-editor/platform'

const NO_VALUE = '—'

export function formatCurrency(value: number, currency: string): string {
  return `${currency === 'CNY' ? '¥' : '$'}${value.toLocaleString(undefined, {
    maximumFractionDigits: 2,
  })}`
}

export function usageKindLabel(kind: AiAccountUsage['kind']): string {
  switch (kind) {
    case 'quota':
      return localize('aiModels.usage.kind.quota', 'Quota')
    case 'balance':
      return localize('aiModels.usage.kind.balance', 'Balance')
    case 'subscription':
      return localize('aiModels.usage.kind.subscription', 'Subscription')
  }
}

/**
 * The header badge: the shortest honest reading of this account's standing.
 *
 * A balance counts down, so its remaining figure is the whole story; a quota or
 * subscription is only meaningful against its ceiling, so those read as
 * "used / limit". When the gateway reports neither, the badge says so rather
 * than showing a number it does not have — a lone figure in a two-number slot
 * would be read as whichever half the user expected.
 */
export function formatUsageBadge(usage: AiAccountUsage): string {
  const currency = usage.currency ?? 'USD'
  const money = (value: number | undefined): string =>
    value === undefined ? NO_VALUE : formatCurrency(value, currency)

  if (usage.kind === 'balance' && usage.remainingUSD !== undefined) {
    return money(usage.remainingUSD)
  }

  if (usage.limitUSD !== undefined) return `${money(usage.usedUSD)} / ${money(usage.limitUSD)}`
  if (usage.remainingUSD !== undefined) return money(usage.remainingUSD)
  // A bare "used" reads as "remaining" on a balance, so it needs the label the
  // badge has no room for. The tooltip carries it; the badge defers.
  if (usage.usedUSD !== undefined && usage.kind !== 'balance') return money(usage.usedUSD)

  // Percentage windows are the only figure a subscription-style source may carry.
  const window = usage.windows?.[0]
  if (window !== undefined) return `${Math.round(window.usedPercent)}%`

  return localize('aiModels.usage.badge.noValues', 'No values reported')
}

/** The badge tooltip: every figure the source did report, on one line. */
export function formatUsageTooltip(usage: AiAccountUsage): string {
  const currency = usage.currency ?? 'USD'
  const parts: string[] = [usageKindLabel(usage.kind)]
  if (usage.usedUSD !== undefined) {
    parts.push(
      `${localize('aiModels.usage.used', 'Used')} ${formatCurrency(usage.usedUSD, currency)}`,
    )
  }
  if (usage.limitUSD !== undefined) {
    parts.push(
      `${localize('aiModels.usage.limit', 'Limit')} ${formatCurrency(usage.limitUSD, currency)}`,
    )
  }
  if (usage.remainingUSD !== undefined) {
    parts.push(
      `${localize('aiModels.usage.remaining', 'Remaining')} ${formatCurrency(
        usage.remainingUSD,
        currency,
      )}`,
    )
  }
  for (const window of usage.windows ?? []) {
    parts.push(`${window.label} ${Math.round(window.usedPercent)}%`)
  }
  parts.push(
    localize('aiModels.usage.fetchedAt', 'Fetched {time}', { time: formatTime(usage.fetchedAt) }),
  )
  return parts.join(' · ')
}

export function formatTime(ms: number): string {
  return new Date(ms).toLocaleString()
}
