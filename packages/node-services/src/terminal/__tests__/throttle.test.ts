/*---------------------------------------------------------------------------------------------
 *  Tests for TerminalDataThrottler.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { TerminalDataThrottler } from '../throttle.js'

const disposables: TerminalDataThrottler[] = []

afterEach(() => {
  for (const d of disposables.splice(0)) d.dispose()
  vi.useRealTimers()
})

function makeThrottler(windowMs = 5): {
  throttler: TerminalDataThrottler
  emitted: Array<{ id: string; data: string }>
} {
  const emitted: Array<{ id: string; data: string }> = []
  const throttler = new TerminalDataThrottler((id, data) => emitted.push({ id, data }), windowMs)
  disposables.push(throttler)
  return { throttler, emitted }
}

describe('TerminalDataThrottler', () => {
  it('merges rapid chunks for the same id into one emission', async () => {
    vi.useFakeTimers()
    const { throttler, emitted } = makeThrottler(5)

    throttler.push('t1', 'hel')
    throttler.push('t1', 'lo')
    await vi.advanceTimersByTimeAsync(6)

    expect(emitted).toEqual([{ id: 't1', data: 'hello' }])
  })

  it('keeps different ids in separate batches', async () => {
    vi.useFakeTimers()
    const { throttler, emitted } = makeThrottler(5)

    throttler.push('a', 'A')
    throttler.push('b', 'B')
    await vi.advanceTimersByTimeAsync(6)

    expect(emitted).toEqual([
      { id: 'a', data: 'A' },
      { id: 'b', data: 'B' },
    ])
  })

  it('flushes once per window, merging chunks that arrive within it', async () => {
    vi.useFakeTimers()
    const { throttler, emitted } = makeThrottler(5)

    throttler.push('t1', '1')
    await vi.advanceTimersByTimeAsync(3)
    throttler.push('t1', '2')
    // The window is anchored to the first push: it flushes at 5ms, not extended.
    await vi.advanceTimersByTimeAsync(2)
    expect(emitted).toEqual([{ id: 't1', data: '12' }])

    // A later chunk opens a fresh window.
    throttler.push('t1', '3')
    await vi.advanceTimersByTimeAsync(6)
    expect(emitted).toEqual([
      { id: 't1', data: '12' },
      { id: 't1', data: '3' },
    ])
  })

  it('ignores empty chunks', async () => {
    vi.useFakeTimers()
    const { throttler, emitted } = makeThrottler(5)

    throttler.push('t1', '')
    await vi.advanceTimersByTimeAsync(6)

    expect(emitted).toEqual([])
  })

  it('dispose drops pending batches without emitting', async () => {
    vi.useFakeTimers()
    const { throttler, emitted } = makeThrottler(5)
    throttler.push('t1', 'pending')
    throttler.dispose()
    await vi.advanceTimersByTimeAsync(100)
    expect(emitted).toEqual([])
  })
})
