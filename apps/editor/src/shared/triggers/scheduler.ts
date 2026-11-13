/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Pure scheduling decisions for a `schedule` trigger source. The main process only
 *  arms one timer for `next`; this module says what is due and what was missed.
 *--------------------------------------------------------------------------------------------*/

import { nextCronTime, parseCron } from './cron.js'
import type { TriggerSourceConfig } from './types.js'

export type ScheduleSourceConfig = Extract<TriggerSourceConfig, { readonly type: 'schedule' }>

export const DEFAULT_MISSED_GRACE_MS = 2 * 60_000

/** Upper bound on enumerated occurrences; older ones only affect the `skipped` count. */
const MAX_ENUMERATED_OCCURRENCES = 10_000

export interface ScheduleDecision {
  readonly due: readonly number[]
  readonly next: number | undefined
  readonly skipped: number
}

function decideMissed(
  latest: number,
  occurrences: number,
  now: number,
  graceMs: number,
  onMissed: ScheduleSourceConfig['onMissed'],
): ScheduleDecision {
  if (onMissed === 'catch-up-once' || now - latest <= graceMs) {
    return { due: [latest], next: undefined, skipped: Math.max(0, occurrences - 1) }
  }
  return { due: [], next: undefined, skipped: occurrences }
}

/**
 * @param lastScheduledAt the planned time of the previous wake-up, `undefined` on first
 *   enable (no catch-up: only the next time is returned).
 * @param graceMs how long after its planned time an occurrence still counts as "just
 *   arrived"; older ones are missed and governed by `onMissed`.
 */
export function computeDue(
  source: ScheduleSourceConfig,
  lastScheduledAt: number | undefined,
  now: number,
  graceMs = DEFAULT_MISSED_GRACE_MS,
): ScheduleDecision {
  if (source.everyMin !== undefined) {
    return computeEveryMin(source, source.everyMin, lastScheduledAt, now, graceMs)
  }
  if (source.cron !== undefined) {
    return computeCron(source, source.cron, lastScheduledAt, now, graceMs)
  }
  return { due: [], next: undefined, skipped: 0 }
}

function computeEveryMin(
  source: ScheduleSourceConfig,
  everyMin: number,
  lastScheduledAt: number | undefined,
  now: number,
  graceMs: number,
): ScheduleDecision {
  if (!Number.isInteger(everyMin) || everyMin < 1) {
    return { due: [], next: undefined, skipped: 0 }
  }
  const interval = everyMin * 60_000
  if (lastScheduledAt === undefined) {
    return { due: [], next: now + interval, skipped: 0 }
  }
  if (lastScheduledAt >= now) {
    return { due: [], next: lastScheduledAt + interval, skipped: 0 }
  }
  const occurrences = Math.floor((now - lastScheduledAt) / interval)
  const next = lastScheduledAt + (occurrences + 1) * interval
  if (occurrences < 1) return { due: [], next, skipped: 0 }
  const latest = lastScheduledAt + occurrences * interval
  return { ...decideMissed(latest, occurrences, now, graceMs, source.onMissed), next }
}

function computeCron(
  source: ScheduleSourceConfig,
  expression: string,
  lastScheduledAt: number | undefined,
  now: number,
  graceMs: number,
): ScheduleDecision {
  const parsed = parseCron(expression)
  if (!parsed.ok) return { due: [], next: undefined, skipped: 0 }
  const next = nextCronTime(parsed.cron, now)
  if (lastScheduledAt === undefined || next === undefined) {
    return { due: [], next, skipped: 0 }
  }
  const occurrences: number[] = []
  let cursor = lastScheduledAt
  while (occurrences.length < MAX_ENUMERATED_OCCURRENCES) {
    const at = nextCronTime(parsed.cron, cursor)
    if (at === undefined || at > now) break
    occurrences.push(at)
    cursor = at
  }
  const latest = occurrences[occurrences.length - 1]
  if (latest === undefined) return { due: [], next, skipped: 0 }
  return { ...decideMissed(latest, occurrences.length, now, graceMs, source.onMissed), next }
}
