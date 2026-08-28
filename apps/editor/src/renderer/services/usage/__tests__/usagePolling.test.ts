/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for services/usage/usagePolling.ts.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PollingLoop } from '../usagePolling.js'

/** Injectable visibility owner with a helper that fires the listener like the browser would. */
function fakeDocument(initial: 'visible' | 'hidden' = 'visible'): {
  visibilityState: string
  listeners: Set<() => void>
  addEventListener(type: 'visibilitychange', listener: () => void): void
  removeEventListener(type: 'visibilitychange', listener: () => void): void
  setVisibility(state: 'visible' | 'hidden'): void
} {
  const listeners = new Set<() => void>()
  return {
    visibilityState: initial,
    listeners,
    addEventListener(_type, listener) {
      listeners.add(listener)
    },
    removeEventListener(_type, listener) {
      listeners.delete(listener)
    },
    setVisibility(state) {
      this.visibilityState = state
      for (const listener of [...listeners]) listener()
    },
  }
}

describe('PollingLoop', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('ticks at the interval returned by interval()', async () => {
    const onTick = vi.fn()
    const loop = new PollingLoop({ interval: () => 60_000, onTick, document: fakeDocument() })
    loop.restart()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(onTick).toHaveBeenCalledTimes(2)
    loop.dispose()
  })

  it('re-reads interval() on restart', async () => {
    let interval = 60_000
    const onTick = vi.fn()
    const loop = new PollingLoop({ interval: () => interval, onTick, document: fakeDocument() })
    loop.restart()
    interval = 1_000
    loop.restart()
    await vi.advanceTimersByTimeAsync(3_000)
    expect(onTick).toHaveBeenCalledTimes(3)
    loop.dispose()
  })

  it('pauses while hidden and restarts with an immediate tick when visible', async () => {
    const onTick = vi.fn()
    const doc = fakeDocument()
    const loop = new PollingLoop({ interval: () => 1_000, onTick, document: doc })
    loop.restart()
    await vi.advanceTimersByTimeAsync(2_500)
    expect(onTick).toHaveBeenCalledTimes(2)

    doc.setVisibility('hidden')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(onTick).toHaveBeenCalledTimes(2)

    doc.setVisibility('visible')
    expect(onTick).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(onTick).toHaveBeenCalledTimes(4)
    loop.dispose()
  })

  it('arms the interval when there is no document at all', async () => {
    const onTick = vi.fn()
    const loop = new PollingLoop({ interval: () => 1_000, onTick })
    loop.restart()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(onTick).toHaveBeenCalledTimes(2)
    loop.dispose()
  })

  it('does nothing on restart while hidden', async () => {
    const onTick = vi.fn()
    const loop = new PollingLoop({
      interval: () => 1_000,
      onTick,
      document: fakeDocument('hidden'),
    })
    loop.restart()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(onTick).not.toHaveBeenCalled()
    loop.dispose()
  })

  it('stops ticking and removes the listener on dispose', async () => {
    const onTick = vi.fn()
    const doc = fakeDocument()
    const loop = new PollingLoop({ interval: () => 1_000, onTick, document: doc })
    loop.restart()
    loop.dispose()
    expect(doc.listeners.size).toBe(0)
    await vi.advanceTimersByTimeAsync(5_000)
    expect(onTick).not.toHaveBeenCalled()
  })

  it('survives a rejecting tick', async () => {
    const onTick = vi.fn().mockRejectedValue(new Error('boom'))
    const loop = new PollingLoop({ interval: () => 1_000, onTick, document: fakeDocument() })
    loop.restart()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(onTick).toHaveBeenCalledTimes(2)
    loop.dispose()
  })
})
