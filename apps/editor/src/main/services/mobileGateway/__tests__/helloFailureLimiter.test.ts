import { describe, expect, it } from 'vitest'
import {
  HELLO_FAILURE_WINDOW_MS,
  HelloFailureLimiter,
  MAX_HELLO_FAILURES_PER_ADDRESS,
} from '../helloFailureLimiter.js'

function makeLimiter(start = 1_000): {
  limiter: HelloFailureLimiter
  advance: (ms: number) => void
} {
  let now = start
  return {
    limiter: new HelloFailureLimiter(() => now),
    advance: (ms) => {
      now += ms
    },
  }
}

describe('HelloFailureLimiter', () => {
  it('audits the first failure, suppresses the middle, then writes one summary', () => {
    const { limiter } = makeLimiter()
    const decisions = Array.from({ length: MAX_HELLO_FAILURES_PER_ADDRESS }, () =>
      limiter.recordFailure('192.0.2.10'),
    )
    expect(decisions[0]).toEqual({ blocked: false, audit: true, suppressed: 0 })
    expect(decisions[1]).toEqual({ blocked: false, audit: false, suppressed: 1 })
    expect(decisions[MAX_HELLO_FAILURES_PER_ADDRESS - 2]).toEqual({
      blocked: false,
      audit: false,
      suppressed: MAX_HELLO_FAILURES_PER_ADDRESS - 2,
    })
    const summary = decisions[MAX_HELLO_FAILURES_PER_ADDRESS - 1]
    expect(summary).toEqual({
      blocked: true,
      audit: true,
      suppressed: MAX_HELLO_FAILURES_PER_ADDRESS - 2,
    })
    expect(limiter.isBlocked('192.0.2.10')).toBe(true)
    expect(limiter.isBlocked('192.0.2.11')).toBe(false)
  })

  it('stops auditing failures once the address is blocked', () => {
    const { limiter } = makeLimiter()
    for (let index = 0; index < MAX_HELLO_FAILURES_PER_ADDRESS; index += 1) {
      limiter.recordFailure('192.0.2.10')
    }
    expect(limiter.recordFailure('192.0.2.10').audit).toBe(false)
  })

  it('unblocks after the sliding window elapses', () => {
    const { limiter, advance } = makeLimiter()
    for (let index = 0; index < MAX_HELLO_FAILURES_PER_ADDRESS; index += 1) {
      limiter.recordFailure('192.0.2.10')
    }
    expect(limiter.isBlocked('192.0.2.10')).toBe(true)
    advance(HELLO_FAILURE_WINDOW_MS)
    expect(limiter.isBlocked('192.0.2.10')).toBe(false)
    expect(limiter.recordFailure('192.0.2.10')).toEqual({
      blocked: false,
      audit: true,
      suppressed: 0,
    })
  })
})
