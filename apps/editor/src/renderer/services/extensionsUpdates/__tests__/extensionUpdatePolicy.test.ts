import { describe, expect, it } from 'vitest'
import {
  parsePublishedAt,
  planAutoUpdates,
  updateSetSignature,
  type IAutoUpdateCandidate,
} from '../extensionUpdatePolicy.js'

const HOUR = 60 * 60 * 1000
const NOW = Date.UTC(2026, 0, 1, 12, 0, 0)

function candidate(overrides: Partial<IAutoUpdateCandidate> = {}): IAutoUpdateCandidate {
  return {
    identifier: 'acme.sample',
    enabled: true,
    optedOut: false,
    publishedAt: NOW - 10 * HOUR,
    ...overrides,
  }
}

describe('planAutoUpdates', () => {
  it('applies a candidate published exactly the delay ago', () => {
    const plan = planAutoUpdates([candidate({ publishedAt: NOW - 2 * HOUR })], {
      now: NOW,
      delayMs: 2 * HOUR,
    })
    expect(plan.apply).toEqual(['acme.sample'])
    expect(plan.skipped).toEqual([])
    expect(plan.nextEligibleAt).toBeUndefined()
  })

  it('defers a candidate published one millisecond inside the window', () => {
    const publishedAt = NOW - 2 * HOUR + 1
    const plan = planAutoUpdates([candidate({ publishedAt })], { now: NOW, delayMs: 2 * HOUR })
    expect(plan.apply).toEqual([])
    expect(plan.skipped).toEqual([{ identifier: 'acme.sample', reason: 'delay' }])
    expect(plan.nextEligibleAt).toBe(publishedAt + 2 * HOUR)
  })

  it('reports the earliest eligibility across several deferred candidates', () => {
    const soon = NOW - HOUR
    const later = NOW - 30 * 60 * 1000
    const plan = planAutoUpdates(
      [
        candidate({ identifier: 'acme.later', publishedAt: later }),
        candidate({ identifier: 'acme.soon', publishedAt: soon }),
      ],
      { now: NOW, delayMs: 2 * HOUR },
    )
    expect(plan.apply).toEqual([])
    expect(plan.nextEligibleAt).toBe(soon + 2 * HOUR)
  })

  it('skips a disabled extension however old the release is', () => {
    const plan = planAutoUpdates([candidate({ enabled: false })], { now: NOW, delayMs: 2 * HOUR })
    expect(plan.apply).toEqual([])
    expect(plan.skipped).toEqual([{ identifier: 'acme.sample', reason: 'disabled' }])
    // Nothing is pending on a timer: the user's choice is not a delay.
    expect(plan.nextEligibleAt).toBeUndefined()
  })

  it('skips an opted-out extension however old the release is', () => {
    const plan = planAutoUpdates([candidate({ optedOut: true })], { now: NOW, delayMs: 2 * HOUR })
    expect(plan.apply).toEqual([])
    expect(plan.skipped).toEqual([{ identifier: 'acme.sample', reason: 'optedOut' }])
    expect(plan.nextEligibleAt).toBeUndefined()
  })

  it('applies a candidate with no usable publish time', () => {
    const plan = planAutoUpdates([candidate({ publishedAt: undefined })], {
      now: NOW,
      delayMs: 2 * HOUR,
    })
    expect(plan.apply).toEqual(['acme.sample'])
    expect(plan.nextEligibleAt).toBeUndefined()
  })

  it('applies everything when the delay is zero', () => {
    const plan = planAutoUpdates([candidate({ publishedAt: NOW })], { now: NOW, delayMs: 0 })
    expect(plan.apply).toEqual(['acme.sample'])
  })
})

describe('parsePublishedAt', () => {
  it('parses an ISO timestamp', () => {
    expect(parsePublishedAt('2026-01-01T00:00:00Z')).toBe(Date.UTC(2026, 0, 1))
  })

  it('returns undefined for a missing or unparseable value', () => {
    expect(parsePublishedAt(undefined)).toBeUndefined()
    expect(parsePublishedAt('not a date')).toBeUndefined()
  })
})

describe('updateSetSignature', () => {
  it('is order-independent and distinguishes versions', () => {
    const a = { identifier: 'acme.a', toVersion: '2.0.0' }
    const b = { identifier: 'acme.b', toVersion: '3.0.0' }
    expect(updateSetSignature([a, b])).toBe(updateSetSignature([b, a]))
    expect(updateSetSignature([a])).not.toBe(updateSetSignature([{ ...a, toVersion: '2.0.1' }]))
  })

  it('is empty for an empty set', () => {
    expect(updateSetSignature([])).toBe('')
  })
})
