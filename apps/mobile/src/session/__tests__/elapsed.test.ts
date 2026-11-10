import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useElapsedTime } from '../elapsed.js'

describe('useElapsedTime', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('ticks once a second while the tool runs', () => {
    let now = 1_000
    const { result } = renderHook(() => useElapsedTime(true, 1_000, undefined, () => now))
    expect(result.current).toBe('0s')

    now = 4_000
    act(() => {
      vi.advanceTimersByTime(1_000)
    })
    expect(result.current).toBe('3s')
  })

  it('freezes at the recorded span once settled', () => {
    const { result } = renderHook(() => useElapsedTime(false, 1_000, 5_000, () => 99_000))
    expect(result.current).toBe('5s')
  })

  it('returns null without a start time', () => {
    const { result } = renderHook(() => useElapsedTime(true, undefined, undefined, () => 0))
    expect(result.current).toBeNull()
  })

  it('clamps a negative PC-clock span to zero', () => {
    const { result } = renderHook(() => useElapsedTime(true, 10_000, undefined, () => 5_000))
    expect(result.current).toBe('0s')
  })
})
