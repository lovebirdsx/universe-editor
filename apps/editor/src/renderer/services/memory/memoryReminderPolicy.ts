/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  When a renderer's memory has been high long enough to be worth interrupting the user
 *  about. Pure arithmetic over the samples the watermark already takes — no timers, no
 *  storage, no notifications, no DOM, so the decision can be replayed in a node test.
 *
 *  Why it exists: the shipped crash sat above the elevated line for 20+ minutes while
 *  every release returned 0.0MB and nothing told the user. The watermark's own releasers
 *  are the first answer to a high heap; this is the second, for when they demonstrably
 *  are not working.
 *--------------------------------------------------------------------------------------------*/

import { MemoryPressureLevel } from './memoryPressureLevels.js'

const MINUTE = 60_000
const MIB = 1024 * 1024

/**
 * How long the heap has to stay high before the user is worth interrupting.
 *
 * Ten minutes, from the one crash this feature has: the window sat above the elevated
 * line for 20+ minutes before V8 aborted, so ten leaves half the incident to act on. The
 * cost of being wrong in this direction is a reminder that was not needed; the cost of
 * the other direction is a window that dies with no one warned.
 */
export const MEMORY_REMINDER_SUSTAIN_MS = 10 * MINUTE

/**
 * A gap between readings this long means nothing was observing the heap, and the stretch
 * it covers must not be counted as "high for that long" — the reminder claims the heap
 * was measurably high the whole time.
 *
 * Three minutes rather than a multiple of the pressured cadence: Chromium throttles
 * timers in a background window hard enough to exceed a minute, and a window that was
 * simply in the background is not a window whose readings stopped.
 */
export const MEMORY_REMINDER_OBSERVATION_GAP_MS = 3 * MINUTE

/**
 * How long after a reminder before another one could be shown at all. This is the half of
 * the anti-harassment rule that survives a reload: `reminded` below dies with the
 * renderer, this one is read back from sessionStorage. Longer than the sustain window on
 * purpose — otherwise reloading would be a way to be asked again.
 */
export const MEMORY_REMINDER_COOLDOWN_MS = 30 * MINUTE

/**
 * Cost model for the pause a capture causes, in the units the user thinks in.
 *
 * Both terms come from measurements already in `docs/development/memory-pressure.md`:
 * ~15–19ms per MB of live heap, and 49MB→2s. The fixed term is what makes the small end
 * right — the baseline is always captured on a small heap, where per-MB alone predicts a
 * pause shorter than the 85MB file write and rename that also happen. The linear term
 * takes the slow end of the measured range so the sentence stays true.
 */
export const SNAPSHOT_PAUSE_FIXED_MS = 1_000
export const SNAPSHOT_PAUSE_PER_MB_MS = 19

export type MemoryReminderReason =
  /** The heap has been high long enough and nothing has released it. */
  | 'remind'
  /** Below the line (or back below it): the releasers are doing their job. */
  | 'at-normal'
  /** Readings stopped coming; the stretch cannot be claimed as observed. */
  | 'observation-gap'
  /** Already told this window. */
  | 'reminded'
  /** Told recently enough that saying it again would be pestering. */
  | 'cooldown'
  /** High, but not for long enough yet. */
  | 'too-brief'

export interface MemoryReminderState {
  /** When the current unbroken stretch above the line began; undefined: not in one. */
  readonly sustainedSince: number | undefined
  /** Previous reading, for spotting the observations stopping. */
  readonly lastSampleAt: number | undefined
  /** Whether this renderer has already shown the reminder. */
  readonly reminded: boolean
  /** When the reminder was last shown; carried across reloads by the caller. */
  readonly lastRemindedAt: number | undefined
}

export const INITIAL_MEMORY_REMINDER_STATE: MemoryReminderState = {
  sustainedSince: undefined,
  lastSampleAt: undefined,
  reminded: false,
  lastRemindedAt: undefined,
}

export interface MemoryReminderInput {
  readonly at: number
  readonly level: MemoryPressureLevel
  readonly used: number
}

export interface MemoryReminderOptions {
  readonly sustainMs?: number
  readonly cooldownMs?: number
  readonly observationGapMs?: number
}

export interface MemoryReminderDecision {
  readonly state: MemoryReminderState
  readonly remind: boolean
  readonly reason: MemoryReminderReason
  /** Present when `remind`: how long the heap has been high, for the sentence. */
  readonly sustainedMs?: number
  /** Present when `remind`: the reading the estimate is made from. */
  readonly used?: number
}

/**
 * Fold one reading into the reminder state.
 *
 * Order matters and is part of the contract: `at-normal` and `observation-gap` reset the
 * stretch first, then "may we interrupt at all" (`reminded`, `cooldown`) is answered
 * before "has it been long enough" (`too-brief`) — so the reason explains the refusal
 * that actually applies, and a reminder that is being withheld cannot burn itself later.
 *
 * "The releasers did not bring it down" is not a separate input: it is exactly the
 * absence of an `at-normal` reading in the stretch. The level only returns to normal
 * once the heap clears the line by the hysteresis band in `evaluatePressure`, so anything
 * a release actually achieved shows up here as a reset.
 */
export function reduceMemoryReminder(
  state: MemoryReminderState,
  input: MemoryReminderInput,
  options: MemoryReminderOptions = {},
): MemoryReminderDecision {
  const sustainMs = options.sustainMs ?? MEMORY_REMINDER_SUSTAIN_MS
  const cooldownMs = options.cooldownMs ?? MEMORY_REMINDER_COOLDOWN_MS
  const gapMs = options.observationGapMs ?? MEMORY_REMINDER_OBSERVATION_GAP_MS

  // A clock that moved backwards is an interrupted observation, not a negative age.
  const interrupted =
    state.lastSampleAt !== undefined &&
    (input.at < state.lastSampleAt || input.at - state.lastSampleAt > gapMs)
  const base: MemoryReminderState = { ...state, lastSampleAt: input.at }

  if (input.level === MemoryPressureLevel.Normal) {
    return hold({ ...base, sustainedSince: undefined }, 'at-normal')
  }
  if (interrupted) {
    return hold({ ...base, sustainedSince: input.at }, 'observation-gap')
  }
  if (state.reminded) {
    return hold(base, 'reminded')
  }
  if (state.lastRemindedAt !== undefined && input.at - state.lastRemindedAt < cooldownMs) {
    return hold(base, 'cooldown')
  }

  const sustainedSince = state.sustainedSince ?? input.at
  const sustainedMs = input.at - sustainedSince
  const next: MemoryReminderState = { ...base, sustainedSince }
  if (sustainedMs < sustainMs) {
    return hold(next, 'too-brief')
  }
  return { state: next, remind: true, reason: 'remind', sustainedMs, used: input.used }
}

function hold(state: MemoryReminderState, reason: MemoryReminderReason): MemoryReminderDecision {
  return { state, remind: false, reason }
}

/**
 * Commit a reminder the caller has actually shown. Kept apart from the decision above so
 * that a reminder withheld for a reason — a round already running, for instance — does
 * not spend the window's one reminder before the user ever sees it.
 *
 * The stretch in progress is deliberately left alone: showing the reminder says nothing
 * about the heap, so a caller that could not display it keeps its reading.
 */
export function markReminded(state: MemoryReminderState, at: number): MemoryReminderState {
  return { ...state, reminded: true, lastRemindedAt: at }
}

/**
 * Upper bound on how long a capture will pause the window, in seconds, from the reading
 * the user is currently looking at. Quoted as a bound in the sentence because the capture
 * itself runs on the smaller post-reload heap.
 */
export function estimateSnapshotPauseSeconds(usedBytes: number): number {
  if (!Number.isFinite(usedBytes) || usedBytes <= 0) return 1
  const ms = SNAPSHOT_PAUSE_FIXED_MS + (usedBytes / MIB) * SNAPSHOT_PAUSE_PER_MB_MS
  return Math.max(1, Math.ceil(ms / 1000))
}
