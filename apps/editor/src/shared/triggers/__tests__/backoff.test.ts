import { describe, expect, it } from 'vitest'
import { nextBackoffMs, shouldAutoPause } from '../backoff.js'

const MINUTE = 60_000

describe('nextBackoffMs', () => {
  it('doubles from one minute and caps at one hour', () => {
    expect(nextBackoffMs(0)).toBe(0)
    expect(nextBackoffMs(1)).toBe(1 * MINUTE)
    expect(nextBackoffMs(2)).toBe(2 * MINUTE)
    expect(nextBackoffMs(3)).toBe(4 * MINUTE)
    expect(nextBackoffMs(5)).toBe(16 * MINUTE)
    expect(nextBackoffMs(6)).toBe(32 * MINUTE)
    expect(nextBackoffMs(7)).toBe(60 * MINUTE)
    expect(nextBackoffMs(50)).toBe(60 * MINUTE)
  })
})

describe('shouldAutoPause', () => {
  it('uses the default threshold', () => {
    expect(shouldAutoPause(4)).toBe(false)
    expect(shouldAutoPause(5)).toBe(true)
    expect(shouldAutoPause(9)).toBe(true)
  })

  it('honors a custom threshold and disables on zero', () => {
    expect(shouldAutoPause(2, 2)).toBe(true)
    expect(shouldAutoPause(1, 2)).toBe(false)
    expect(shouldAutoPause(100, 0)).toBe(false)
  })
})
