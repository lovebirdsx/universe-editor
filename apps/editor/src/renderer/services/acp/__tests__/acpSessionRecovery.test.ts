/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_RECOVERY_ATTEMPTS, SessionRecovery, recoveryBackoffMs } from '../acpSessionRecovery.js'

describe('recoveryBackoffMs', () => {
  it('increases across attempts and stays within jitter bounds', () => {
    // attempt=2 → first backoff (~2s), attempt=3 → ~8s, attempt≥4 clamps (~20s)
    for (const [attempt, base] of [
      [2, 2_000],
      [3, 8_000],
      [4, 20_000],
      [9, 20_000],
    ] as const) {
      for (let i = 0; i < 50; i++) {
        const ms = recoveryBackoffMs(attempt)
        expect(ms).toBeGreaterThanOrEqual(Math.floor(base * 0.75))
        expect(ms).toBeLessThanOrEqual(Math.ceil(base * 1.25))
      }
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
