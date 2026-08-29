/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Pure normalization for official-subscription usage (Claude's claude.ai plan
 *  rate-limit windows, Codex's ChatGPT plan rate limits) into one vendor-neutral
 *  snapshot the UI can render without knowing which agent produced it.
 *
 *  Normalization lives here — not in the two agent forks — for two reasons: the
 *  forks' headline rule is "keep the diff against upstream minimal", and two
 *  independent copies of this logic would inevitably drift.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '@universe-editor/platform'
import type { AiAccountUsage } from '@universe-editor/platform'

/** One rate-limit window (a 5-hour bucket, a weekly bucket, a per-model bucket…). */
export interface SubscriptionUsageWindow {
  /**
   * Stable identity, vendor-prefixed so buckets from different agents can never
   * collide in a shared map (`claude:five_hour`, `codex:primary`,
   * `codex:limit:<id>:primary`).
   */
  readonly id: string
  readonly label: string
  /** 0-100. */
  readonly usedPercent: number
  /** Epoch milliseconds; absent when the vendor did not report a reset time. */
  readonly resetsAt?: number
}

/** Codex-only: prepaid credits that reset a hit rate limit early. */
export interface SubscriptionResetCredits {
  readonly availableCount: number
  /** Epoch ms when the soonest available credit expires; absent when details were withheld. */
  readonly earliestExpiresAt?: number
}

/** Claude-only: pay-as-you-go spend on top of the plan's included usage. */
export interface SubscriptionExtraUsage {
  readonly enabled: boolean
  readonly usedPercent?: number
  readonly usedCredits?: number
  readonly monthlyLimit?: number
  readonly currency?: string
}

export interface SubscriptionUsageSnapshot {
  readonly agentId: string
  /** 'pro' / 'max' / 'plus' / … as reported by the vendor; absent when unknown. */
  readonly planLabel?: string
  readonly windows: readonly SubscriptionUsageWindow[]
  readonly resetCredits?: SubscriptionResetCredits
  readonly extraUsage?: SubscriptionExtraUsage
  /** Epoch milliseconds the snapshot was read at. */
  readonly fetchedAt: number
}

/** Which readout the indicator should render for a session. */
export type UsageDisplayKind = 'subscription' | 'account' | 'unavailable' | 'hidden'

/**
 * Account-level usage for the provider *instance* an agent is bound to. This is
 * the authoritative upstream number (`AiAccountUsage`), keyed per instance — the
 * opposite of `SubscriptionUsageSnapshot`, which is a local estimate of the
 * official subscription. It lives here (not in `AccountUsageService.ts`) so the
 * pure `resolveUsageDisplay` below never depends on the service layer.
 */
export interface AccountUsageState {
  /** The bound instance declares an account usage source. */
  readonly hasSource: boolean
  /** Authoritative number; `undefined` while `hasSource` is true means "unavailable". */
  readonly usage?: AiAccountUsage
}

/**
 * Numbers below this are seconds-since-epoch, above are milliseconds. 1e11 ms is
 * 1973 and 1e11 s is the year 5138, so no real timestamp is ambiguous. Codex
 * reports unix seconds in some fields and the app-server does not document the
 * unit for rate-limit windows, hence the sniff.
 */
const EPOCH_SECONDS_CEILING = 1e11

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function clampPercent(value: number): number {
  if (value < 0) return 0
  return value > 100 ? 100 : value
}

/** Normalize a vendor timestamp (ISO 8601 string, unix seconds, or unix ms) to epoch ms. */
export function toEpochMs(value: unknown): number | undefined {
  const numeric = asFiniteNumber(value)
  if (numeric !== undefined) {
    if (numeric <= 0) return undefined
    return numeric < EPOCH_SECONDS_CEILING ? Math.round(numeric * 1000) : Math.round(numeric)
  }
  const text = asNonEmptyString(value)
  if (text === undefined) return undefined
  const parsed = Date.parse(text)
  return Number.isNaN(parsed) ? undefined : parsed
}

/** The soonest expiry among still-available credits; withheld or malformed details contribute nothing. */
function earliestCreditExpiry(raw: unknown): number | undefined {
  if (!Array.isArray(raw)) return undefined
  let earliest: number | undefined
  for (const entry of raw) {
    const credit = asRecord(entry)
    if (credit === undefined || credit['status'] !== 'available') continue
    const expiresAt = toEpochMs(credit['expiresAt'])
    if (expiresAt === undefined) continue
    if (earliest === undefined || expiresAt < earliest) earliest = expiresAt
  }
  return earliest
}

/** Human label for a rolling window of `minutes`, e.g. 300 → "5-hour", 10080 → "Weekly". */
function windowDurationLabel(minutes: number | undefined): string {
  if (minutes === undefined || minutes <= 0) {
    return localize('acp.subscriptionUsage.window.generic', 'Usage')
  }
  if (minutes % (60 * 24) === 0) {
    const days = minutes / (60 * 24)
    if (days === 7) return localize('acp.subscriptionUsage.window.weekly', 'Weekly')
    if (days === 1) return localize('acp.subscriptionUsage.window.daily', 'Daily')
    return localize('acp.subscriptionUsage.window.days', '{days}-day', { days })
  }
  if (minutes % 60 === 0) {
    return localize('acp.subscriptionUsage.window.hours', '{hours}-hour', {
      hours: minutes / 60,
    })
  }
  return localize('acp.subscriptionUsage.window.minutes', '{minutes}-min', { minutes })
}

const CLAUDE_WINDOW_LABELS: ReadonlyArray<readonly [key: string, label: () => string]> = [
  ['five_hour', () => localize('acp.subscriptionUsage.window.hours', '{hours}-hour', { hours: 5 })],
  ['seven_day', () => localize('acp.subscriptionUsage.window.weekly', 'Weekly')],
  ['seven_day_opus', () => localize('acp.subscriptionUsage.window.weeklyOpus', 'Weekly · Opus')],
  [
    'seven_day_sonnet',
    () => localize('acp.subscriptionUsage.window.weeklySonnet', 'Weekly · Sonnet'),
  ],
  [
    'seven_day_oauth_apps',
    () => localize('acp.subscriptionUsage.window.weeklyOauthApps', 'Weekly · third-party apps'),
  ],
]

function claudeWindow(
  id: string,
  label: string,
  raw: unknown,
): SubscriptionUsageWindow | undefined {
  const rec = asRecord(raw)
  if (rec === undefined) return undefined
  // A null utilization means "the vendor has no figure", not zero — skip the
  // bucket entirely rather than render a misleading empty bar.
  const utilization = asFiniteNumber(rec['utilization'])
  if (utilization === undefined) return undefined
  const resetsAt = toEpochMs(rec['resets_at'])
  return {
    id,
    label,
    usedPercent: clampPercent(utilization),
    ...(resetsAt === undefined ? {} : { resetsAt }),
  }
}

function normalizeClaudeUsage(
  agentId: string,
  rec: Record<string, unknown>,
  fetchedAt: number,
): SubscriptionUsageSnapshot | undefined {
  if (rec['supported'] !== true) return undefined
  // `rateLimitsAvailable: false` is the API-key / Bedrock / Vertex case: the
  // session bills per token, so there is no subscription readout to show and the
  // caller should fall back to the gateway spend figure.
  if (rec['rateLimitsAvailable'] !== true) return undefined
  const rateLimits = asRecord(rec['rateLimits'])
  if (rateLimits === undefined) return undefined

  const windows: SubscriptionUsageWindow[] = []
  for (const [key, label] of CLAUDE_WINDOW_LABELS) {
    const window = claudeWindow(`claude:${key}`, label(), rateLimits[key])
    if (window !== undefined) windows.push(window)
  }
  const modelScoped = rateLimits['model_scoped']
  if (Array.isArray(modelScoped)) {
    for (const entry of modelScoped) {
      const rawEntry = asRecord(entry)
      if (rawEntry === undefined) continue
      const displayName = asNonEmptyString(rawEntry['display_name'])
      if (displayName === undefined) continue
      const window = claudeWindow(`claude:model:${displayName}`, displayName, rawEntry)
      if (window !== undefined) windows.push(window)
    }
  }
  if (windows.length === 0) return undefined

  const planLabel = asNonEmptyString(rec['subscriptionType'])
  const extra = asRecord(rateLimits['extra_usage'])
  const extraUsage: SubscriptionExtraUsage | undefined =
    extra === undefined
      ? undefined
      : {
          enabled: extra['is_enabled'] === true,
          ...pick('usedPercent', asFiniteNumber(extra['utilization'])),
          ...pick('usedCredits', asFiniteNumber(extra['used_credits'])),
          ...pick('monthlyLimit', asFiniteNumber(extra['monthly_limit'])),
          ...pick('currency', asNonEmptyString(extra['currency'])),
        }

  return {
    agentId,
    ...pick('planLabel', planLabel),
    windows,
    ...pick('extraUsage', extraUsage),
    fetchedAt,
  }
}

function codexWindow(
  id: string,
  prefix: string | undefined,
  raw: unknown,
): SubscriptionUsageWindow | undefined {
  const rec = asRecord(raw)
  if (rec === undefined) return undefined
  const usedPercent = asFiniteNumber(rec['usedPercent'])
  if (usedPercent === undefined) return undefined
  const duration = windowDurationLabel(asFiniteNumber(rec['windowDurationMins']))
  const resetsAt = toEpochMs(rec['resetsAt'])
  return {
    id,
    label: prefix === undefined ? duration : `${prefix} · ${duration}`,
    usedPercent: clampPercent(usedPercent),
    ...(resetsAt === undefined ? {} : { resetsAt }),
  }
}

function normalizeCodexUsage(
  agentId: string,
  rec: Record<string, unknown>,
  fetchedAt: number,
): SubscriptionUsageSnapshot | undefined {
  if (rec['supported'] !== true) return undefined

  const windows: SubscriptionUsageWindow[] = []
  let planLabel: string | undefined

  const collect = (idPrefix: string, labelPrefix: string | undefined, snapshot: unknown): void => {
    const bucket = asRecord(snapshot)
    if (bucket === undefined) return
    planLabel ??= asNonEmptyString(bucket['planType'])
    const primary = codexWindow(`${idPrefix}:primary`, labelPrefix, bucket['primary'])
    if (primary !== undefined) windows.push(primary)
    const secondary = codexWindow(`${idPrefix}:secondary`, labelPrefix, bucket['secondary'])
    if (secondary !== undefined) windows.push(secondary)
  }

  // `rateLimits` is the app-server's backward-compatible single-bucket view of
  // the same data `rateLimitsByLimitId` reports per bucket — reading both would
  // double-count, so the richer multi-bucket view wins when present.
  const byLimitId = asRecord(rec['rateLimitsByLimitId'])
  const limitIds = byLimitId === undefined ? [] : Object.keys(byLimitId)
  if (limitIds.length > 0) {
    const showPrefix = limitIds.length > 1
    for (const limitId of limitIds) {
      const bucket = asRecord(byLimitId?.[limitId])
      const name = bucket === undefined ? undefined : asNonEmptyString(bucket['limitName'])
      collect(`codex:limit:${limitId}`, showPrefix ? (name ?? limitId) : undefined, bucket)
    }
  } else {
    collect('codex', undefined, rec['rateLimits'])
  }
  if (windows.length === 0) return undefined

  const credits = asRecord(rec['resetCredits'])
  let resetCredits: SubscriptionResetCredits | undefined
  if (credits !== undefined) {
    // The app-server types availableCount as a Rust u64 and the fork sends it as
    // a decimal string, because JSON.stringify throws on bigint.
    const parsed = Number(credits['availableCount'])
    if (Number.isFinite(parsed) && parsed >= 0)
      resetCredits = {
        availableCount: Math.floor(parsed),
        ...pick('earliestExpiresAt', earliestCreditExpiry(credits['credits'])),
      }
  }

  return {
    agentId,
    ...pick('planLabel', planLabel),
    windows,
    ...pick('resetCredits', resetCredits),
    fetchedAt,
  }
}

/** `exactOptionalPropertyTypes` helper: spread an optional property only when it has a value. */
function pick<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V }
}

/**
 * Normalize whatever the agent fork returned from
 * `universe-editor/subscription_usage`. Dispatches on the payload's own `vendor`
 * tag rather than the agent id, so a custom agent that implements the
 * ext-method lights up the indicator too. Returns `undefined` whenever there is
 * nothing subscription-shaped to show — an expected outcome, not an error.
 */
export function normalizeSubscriptionUsage(
  agentId: string,
  raw: unknown,
  fetchedAt: number,
): SubscriptionUsageSnapshot | undefined {
  const rec = asRecord(raw)
  if (rec === undefined) return undefined
  switch (rec['vendor']) {
    case 'claude':
      return normalizeClaudeUsage(agentId, rec, fetchedAt)
    case 'codex':
      return normalizeCodexUsage(agentId, rec, fetchedAt)
    default:
      return undefined
  }
}

/**
 * The window the user is closest to hitting — the collapsed indicator shows its
 * *remaining* percentage (`100 − usedPercent`), so "how much headroom is left"
 * is one glance away.
 */
export function pickTightestWindow(
  snapshot: SubscriptionUsageSnapshot | undefined,
): SubscriptionUsageWindow | undefined {
  if (snapshot === undefined) return undefined
  let tightest: SubscriptionUsageWindow | undefined
  for (const window of snapshot.windows) {
    if (tightest === undefined || window.usedPercent > tightest.usedPercent) tightest = window
  }
  return tightest
}

/**
 * Whether `window`'s reset time has passed — its `usedPercent` then describes a
 * window that no longer exists, so the number is not merely old but wrong. The
 * UI shows a placeholder for such a window rather than a stale reading.
 */
export function hasWindowRolledOver(
  window: SubscriptionUsageWindow | undefined,
  now: number,
): boolean {
  return window?.resetsAt !== undefined && window.resetsAt <= now
}

/** Whether any of `snapshot`'s windows has rolled over. */
export function hasRolledOver(
  snapshot: SubscriptionUsageSnapshot | undefined,
  now: number,
): boolean {
  return snapshot?.windows.some((w) => hasWindowRolledOver(w, now)) === true
}

/**
 * A snapshot is stale once it is older than `ttlMs`, or once any of its windows
 * has rolled over (its reset time has passed) — at that point the percentages
 * describe a window that no longer exists, which is worse than being merely old.
 */
export function isStale(
  snapshot: SubscriptionUsageSnapshot | undefined,
  now: number,
  ttlMs: number,
): boolean {
  if (snapshot === undefined) return false
  if (now - snapshot.fetchedAt > ttlMs) return true
  return hasRolledOver(snapshot, now)
}

/**
 * The gating table: which readout a session's indicator shows.
 *
 * Priority order is the semantics:
 *  1. Official-subscription snapshot → `'subscription'` (authoritative, wins).
 *  2. Account usage declared AND an authoritative number fetched → `'account'`.
 *  3. Account usage declared but the number is missing → `'unavailable'`.
 *  4. Anything else → `'hidden'`.
 */
export function resolveUsageDisplay(input: {
  readonly snapshot: SubscriptionUsageSnapshot | undefined
  readonly account?: AccountUsageState | undefined
}): UsageDisplayKind {
  if (input.snapshot !== undefined) return 'subscription'
  if (input.account?.hasSource === true) {
    return input.account.usage !== undefined ? 'account' : 'unavailable'
  }
  return 'hidden'
}
