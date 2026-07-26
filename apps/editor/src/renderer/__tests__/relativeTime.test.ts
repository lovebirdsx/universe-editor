/*---------------------------------------------------------------------------------------------
 *  Tests for relativeTime.ts: the shared "just now / {n}m ago / …" bucket
 *  boundaries used by the session list, swarm reviews, and the `#` commit picker.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { relativeTime } from '../relativeTime.js'

const NOW = new Date('2026-07-26T12:00:00Z').getTime()

describe('relativeTime', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns "just now" for timestamps less than a minute old', () => {
    vi.setSystemTime(NOW)
    expect(relativeTime(NOW)).toBe('just now')
    expect(relativeTime(NOW - 59_999)).toBe('just now')
  })

  it('returns minutes for timestamps less than an hour old', () => {
    vi.setSystemTime(NOW)
    expect(relativeTime(NOW - 60_000)).toBe('1m ago')
    expect(relativeTime(NOW - 37 * 60_000)).toBe('37m ago')
    expect(relativeTime(NOW - 3_600_000 + 1)).toBe('59m ago')
  })

  it('returns hours for timestamps less than a day old', () => {
    vi.setSystemTime(NOW)
    expect(relativeTime(NOW - 3_600_000)).toBe('1h ago')
    expect(relativeTime(NOW - 86_400_000 + 1)).toBe('23h ago')
  })

  it('returns days for older timestamps', () => {
    vi.setSystemTime(NOW)
    expect(relativeTime(NOW - 86_400_000)).toBe('1d ago')
    expect(relativeTime(NOW - 4 * 86_400_000)).toBe('4d ago')
  })
})
