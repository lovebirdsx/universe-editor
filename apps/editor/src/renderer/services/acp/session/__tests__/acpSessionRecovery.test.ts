/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MAX_RECOVERY_ATTEMPTS,
  SessionRecovery,
  recoveryBackoffMs,
  retryBudgetFor,
} from '../acpSessionRecovery.js'

describe('recoveryBackoffMs', () => {
  it('increases across attempts and jitters downwards from the table value', () => {
    // attempt=2 → first backoff (~2s), attempt=3 → ~8s, attempt≥4 clamps (~20s).
    // The table value is the *ceiling*: the UI copy promises "at most a minute
    // between attempts", so jitter may only pull a hop earlier.
    for (const [attempt, base] of [
      [2, 2_000],
      [3, 8_000],
      [4, 20_000],
      [9, 20_000],
    ] as const) {
      for (let i = 0; i < 50; i++) {
        const ms = recoveryBackoffMs(attempt)
        expect(ms).toBeGreaterThanOrEqual(Math.floor(base * 0.75))
        expect(ms).toBeLessThanOrEqual(base)
      }
    }
  })

  it('never exceeds the table value even at the top of the jitter range', () => {
    // The regression this guards: jitter applied *after* the cap produced waits
    // up to 75s on the cap tier, i.e. a countdown long enough to read as a hang
    // — exactly what the 60s cap exists to prevent — while the docs still said
    // "at most a minute".
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.999)
    const waits = [2, 3, 4, 5, 6, 7, 8].map((attempt) => recoveryBackoffMs(attempt, 'rate_limit'))
    const transient = [2, 3, 4].map((attempt) => recoveryBackoffMs(attempt))
    random.mockRestore()
    expect(waits).toEqual([5_000, 15_000, 30_000, 60_000, 60_000, 60_000, 60_000])
    expect(transient).toEqual([2_000, 8_000, 20_000])
    // …and the whole episode stays inside the documented budget.
    expect(waits.reduce((sum, ms) => sum + ms, 0)).toBe(290_000)
  })

  it('spreads a rate limit over minutes, never waiting more than a minute at a time', () => {
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5) // neutralises the jitter
    const waits = [2, 3, 4, 5, 6, 7, 8].map((attempt) => recoveryBackoffMs(attempt, 'rate_limit'))
    random.mockRestore()
    expect(waits).toEqual([5_000, 15_000, 30_000, 60_000, 60_000, 60_000, 60_000])
    // Cumulative wait 290s ≈ 5 minutes. The single-hop cap is what keeps the
    // countdown from reading as a hang; buying attempts beats growing one gap.
    expect(waits.reduce((sum, ms) => sum + ms, 0)).toBe(290_000)
  })
})

describe('retryBudgetFor', () => {
  it('maps the retryable classes and refuses the rest', () => {
    expect(retryBudgetFor('rate_limited')).toEqual({ profile: 'rate_limit', maxAttempts: 8 })
    expect(retryBudgetFor('transient')).toEqual({
      profile: 'transient',
      maxAttempts: MAX_RECOVERY_ATTEMPTS,
    })
    for (const cls of ['quota', 'auth', 'fatal', 'agent_crash'] as const) {
      expect(retryBudgetFor(cls)).toBeUndefined()
    }
  })
})

describe('SessionRecovery', () => {
  let rec: SessionRecovery
  beforeEach(() => {
    vi.useFakeTimers()
    rec = new SessionRecovery()
  })
  afterEach(() => {
    rec.dispose()
    vi.useRealTimers()
  })

  it('publishes and clears state', () => {
    expect(rec.state.get()).toBeUndefined()
    rec.set({
      phase: 'retrying',
      attempt: 2,
      maxAttempts: MAX_RECOVERY_ATTEMPTS,
      reason: 'http_429',
    })
    expect(rec.state.get()?.phase).toBe('retrying')
    rec.clear()
    expect(rec.state.get()).toBeUndefined()
  })

  it('sleep resolves after the delay', async () => {
    const done = vi.fn()
    const p = rec.sleep(1000).then(done)
    expect(rec.hasPending).toBe(true)
    await vi.advanceTimersByTimeAsync(999)
    expect(done).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await p
    expect(done).toHaveBeenCalled()
    expect(rec.hasPending).toBe(false)
  })

  it('cancelPending rejects the in-flight sleep', async () => {
    const p = rec.sleep(5000)
    const caught = vi.fn()
    const guarded = p.catch(caught)
    rec.cancelPending()
    await guarded
    expect(caught).toHaveBeenCalled()
    expect(rec.hasPending).toBe(false)
  })

  it('clear also cancels a pending sleep', async () => {
    const caught = vi.fn()
    const guarded = rec.sleep(5000).catch(caught)
    rec.clear()
    await guarded
    expect(caught).toHaveBeenCalled()
  })
})
