/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { MemoryPressureLevel } from '../memoryPressureLevels.js'
import {
  INITIAL_MEMORY_REMINDER_STATE,
  MEMORY_REMINDER_COOLDOWN_MS,
  MEMORY_REMINDER_OBSERVATION_GAP_MS,
  MEMORY_REMINDER_SUSTAIN_MS,
  estimateSnapshotPauseSeconds,
  markReminded,
  reduceMemoryReminder,
  type MemoryReminderInput,
  type MemoryReminderReason,
  type MemoryReminderState,
} from '../memoryReminderPolicy.js'

const MIB = 1024 * 1024
const MINUTE = 60_000

/** Options small enough to read in a test, big enough to hold a real sample count. */
const SHORT = { sustainMs: 5 * MINUTE, cooldownMs: 20 * MINUTE, observationGapMs: MINUTE }

const HIGH_USED = 2 * 1024 * MIB

function sample(at: number, used = HIGH_USED, level = MemoryPressureLevel.Elevated) {
  return { at, used, level } satisfies MemoryReminderInput
}

/**
 * Feed a series and report the first sample that asked for a reminder, plus every reason
 * the others were held back. The interesting cases are the "no", so those are collected.
 */
function feed(
  samples: readonly MemoryReminderInput[],
  initial: MemoryReminderState = INITIAL_MEMORY_REMINDER_STATE,
  options = SHORT,
): { state: MemoryReminderState; remindedAt: number | undefined; reasons: MemoryReminderReason[] } {
  let state = initial
  let remindedAt: number | undefined
  const reasons: MemoryReminderReason[] = []
  for (const input of samples) {
    const decision = reduceMemoryReminder(state, input, options)
    state = decision.state
    if (decision.remind) {
      remindedAt ??= input.at
      // What the caller does once the notification is really on screen.
      state = markReminded(state, input.at)
    } else {
      reasons.push(decision.reason)
    }
  }
  return { state, remindedAt, reasons }
}

/** One sample per half minute, the cadence a pressured sampler runs near. */
function sustained(minutes: number, from = 0, step = 30_000): MemoryReminderInput[] {
  const samples: MemoryReminderInput[] = []
  for (let at = from; at <= from + minutes * MINUTE; at += step) samples.push(sample(at))
  return samples
}

describe('reduceMemoryReminder', () => {
  it('reminds once the heap has stayed high and releasing did not bring it down', () => {
    const { remindedAt } = feed(sustained(5))
    // The line was crossed at t0, so the reminder lands on the sample that completes the
    // window — not before it, and not on some later sample either.
    expect(remindedAt).toBe(5 * MINUTE)
  })

  it('reports how long the heap has been high', () => {
    const samples = sustained(5)
    let state = INITIAL_MEMORY_REMINDER_STATE
    let decision = reduceMemoryReminder(state, samples[0]!, SHORT)
    for (const input of samples.slice(1)) {
      state = decision.state
      decision = reduceMemoryReminder(state, input, SHORT)
    }
    expect(decision.remind).toBe(true)
    expect(decision.sustainedMs).toBe(5 * MINUTE)
    expect(decision.used).toBe(HIGH_USED)
  })

  it('does not remind while the window is shorter than the sustain line', () => {
    const { remindedAt, reasons } = feed(sustained(5).slice(0, -1))
    expect(remindedAt).toBeUndefined()
    expect(reasons).toContain('too-brief')
  })

  it('treats a drop back to normal as relief and starts the window over', () => {
    // 4 minutes high, one normal reading, then 4 more minutes: without the reset the fifth
    // minute would have reminded. The drop is the releasers working — the level only
    // returns to normal once the heap clears the line by the hysteresis band.
    const { remindedAt, reasons } = feed([
      ...sustained(4),
      sample(4.5 * MINUTE, MIB, MemoryPressureLevel.Normal),
      ...sustained(4, 5 * MINUTE),
    ])
    expect(remindedAt).toBeUndefined()
    expect(reasons).toContain('at-normal')
  })

  it('keeps counting while the heap stays high without ever coming back down', () => {
    // The shipped crash sat above the line for 20+ minutes while every release returned
    // nothing, and the reading wobbled by a few percent the whole time. A wobble is not
    // relief: only the level dropping back below the line is.
    const samples: MemoryReminderInput[] = []
    for (let i = 0; i <= 20; i++) {
      samples.push(sample(i * 30_000, HIGH_USED - (i % 2) * 40 * MIB))
    }
    expect(feed(samples).remindedAt).toBe(10 * 30_000)
  })

  it('starts the window over when the readings themselves stopped coming', () => {
    // A window that spent minutes wedged is not a window that has been measurably high for
    // those minutes: nothing observed it. The claim in the reminder has to be true.
    const { remindedAt, reasons } = feed([
      ...sustained(4),
      sample(4 * MINUTE + MEMORY_REMINDER_OBSERVATION_GAP_MS + 1),
      ...sustained(3, 8 * MINUTE),
    ])
    expect(remindedAt).toBeUndefined()
    expect(reasons).toContain('observation-gap')
  })

  it('never reminds twice in one window session', () => {
    const first = feed(sustained(5))
    expect(first.remindedAt).toBe(5 * MINUTE)

    // An hour later — well past any cooldown — it stays silent: the user was already told
    // in this window, and repeating it would be the harassment this guards against.
    const second = feed(sustained(5, 65 * MINUTE), first.state)
    expect(second.remindedAt).toBeUndefined()
    expect(second.reasons).toContain('reminded')
  })

  it('honours the cooldown that outlives the renderer', () => {
    // `reminded` dies with the renderer; the cooldown is read back from sessionStorage, so
    // a reload (for any reason) must not re-arm the reminder on the next high reading.
    const carried: MemoryReminderState = {
      ...INITIAL_MEMORY_REMINDER_STATE,
      lastRemindedAt: 0,
    }
    const withinCooldown = feed(sustained(5, SHORT.cooldownMs - 5 * MINUTE), carried)
    expect(withinCooldown.remindedAt).toBeUndefined()
    expect(withinCooldown.reasons).toContain('cooldown')

    const afterCooldown = feed(sustained(5, SHORT.cooldownMs + MINUTE), carried)
    expect(afterCooldown.remindedAt).toBe(SHORT.cooldownMs + MINUTE + 5 * MINUTE)
  })

  it('survives a clock that moved backwards', () => {
    const state: MemoryReminderState = {
      ...INITIAL_MEMORY_REMINDER_STATE,
      lastSampleAt: 10 * MINUTE,
    }
    const decision = reduceMemoryReminder(state, sample(0), SHORT)
    expect(decision.remind).toBe(false)
    expect(decision.reason).toBe('observation-gap')
    expect(decision.state.sustainedSince).toBe(0)
  })

  it('treats critical like elevated and never reminds below the line', () => {
    const critical = sustained(5).map((input) =>
      sample(input.at, input.used, MemoryPressureLevel.Critical),
    )
    expect(feed(critical).remindedAt).toBe(5 * MINUTE)

    const normal = sustained(5).map((input) => sample(input.at, MIB, MemoryPressureLevel.Normal))
    const { remindedAt, reasons } = feed(normal)
    expect(remindedAt).toBeUndefined()
    expect(reasons.every((reason) => reason === 'at-normal')).toBe(true)
  })

  it('starts the window at the sample that crossed the line, not at the first one seen', () => {
    // Launch readings are normal and the line is crossed later. Measuring from the first
    // sample would call every window "high for 10 minutes" shortly after it crossed.
    const crossedAt = 3 * MINUTE
    const { remindedAt } = feed([
      sample(0, MIB, MemoryPressureLevel.Normal),
      sample(crossedAt),
      ...sustained(5, crossedAt + 30_000),
    ])
    expect(remindedAt).toBe(crossedAt + 5 * MINUTE)
  })

  it('keeps the production constants in the range the prose promises', () => {
    expect(MEMORY_REMINDER_SUSTAIN_MS).toBe(10 * MINUTE)
    // The gap has to clear Chromium's background timer throttling, or a window that was
    // merely in the background would look like one whose readings stopped.
    expect(MEMORY_REMINDER_OBSERVATION_GAP_MS).toBe(3 * MINUTE)
    expect(MEMORY_REMINDER_COOLDOWN_MS).toBe(30 * MINUTE)
    expect(MEMORY_REMINDER_COOLDOWN_MS).toBeGreaterThan(MEMORY_REMINDER_SUSTAIN_MS)
  })
})

describe('markReminded', () => {
  it('records the reminder without discarding the window in progress', () => {
    const state: MemoryReminderState = { ...INITIAL_MEMORY_REMINDER_STATE, sustainedSince: 1_000 }
    const marked = markReminded(state, 5_000)
    expect(marked.reminded).toBe(true)
    expect(marked.lastRemindedAt).toBe(5_000)
    // Committing a reminder is not a verdict on the heap: leave the window alone so a
    // caller that could not actually show the notification does not lose the reading.
    expect(marked.sustainedSince).toBe(1_000)
  })
})

describe('estimateSnapshotPauseSeconds', () => {
  it('quotes the pause as an upper bound built from what was actually measured', () => {
    // 49MB→2s and 15–19ms/MB are the numbers in docs/development/memory-pressure.md; the
    // fixed part is what dominates on the small heap the baseline is taken on, and the
    // linear part takes the slow end of the range so the sentence stays true.
    expect(estimateSnapshotPauseSeconds(49 * MIB)).toBe(2)
    expect(estimateSnapshotPauseSeconds(1024 * MIB)).toBe(21)
  })

  it('never quotes a pause below one second', () => {
    for (const used of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(estimateSnapshotPauseSeconds(used)).toBe(1)
    }
    // A real but tiny heap still rounds up: the fixed part of the capture is real work
    // whether or not the heap behind it is.
    expect(estimateSnapshotPauseSeconds(1)).toBeGreaterThanOrEqual(1)
  })
})
