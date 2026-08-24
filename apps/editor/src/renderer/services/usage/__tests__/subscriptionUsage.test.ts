/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Normalization of the two vendors' subscription-usage payloads into one snapshot.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  isStale,
  normalizeSubscriptionUsage,
  pickTightestWindow,
  resolveUsageDisplay,
  toEpochMs,
  type AccountUsageState,
  type SubscriptionUsageSnapshot,
} from '../subscriptionUsage.js'

const FETCHED_AT = 1_700_000_000_000

function claudePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    vendor: 'claude',
    supported: true,
    subscriptionType: 'max',
    rateLimitsAvailable: true,
    rateLimits: {
      five_hour: { utilization: 42, resets_at: '2023-11-14T23:00:00.000Z' },
      seven_day: { utilization: 71, resets_at: '2023-11-20T00:00:00.000Z' },
    },
    ...overrides,
  }
}

function codexPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    vendor: 'codex',
    supported: true,
    rateLimits: {
      planType: 'plus',
      primary: { usedPercent: 33, windowDurationMins: 300, resetsAt: 1_700_003_600 },
      secondary: { usedPercent: 88, windowDurationMins: 10080, resetsAt: 1_700_600_000 },
    },
    rateLimitsByLimitId: null,
    resetCredits: null,
    ...overrides,
  }
}

describe('toEpochMs', () => {
  it('parses ISO 8601 strings', () => {
    expect(toEpochMs('2023-11-14T22:13:20.000Z')).toBe(FETCHED_AT)
  })

  it('promotes unix seconds to milliseconds', () => {
    expect(toEpochMs(1_700_000_000)).toBe(FETCHED_AT)
  })

  it('passes unix milliseconds through', () => {
    expect(toEpochMs(FETCHED_AT)).toBe(FETCHED_AT)
  })

  it('rejects junk and non-positive numbers', () => {
    expect(toEpochMs(undefined)).toBeUndefined()
    expect(toEpochMs(null)).toBeUndefined()
    expect(toEpochMs(0)).toBeUndefined()
    expect(toEpochMs(-1)).toBeUndefined()
    expect(toEpochMs('not a date')).toBeUndefined()
  })
})

describe('normalizeSubscriptionUsage — claude', () => {
  it('maps the plan windows with epoch-ms reset times', () => {
    const snapshot = normalizeSubscriptionUsage('claude-code', claudePayload(), FETCHED_AT)
    expect(snapshot).toBeDefined()
    expect(snapshot?.planLabel).toBe('max')
    expect(snapshot?.fetchedAt).toBe(FETCHED_AT)
    expect(snapshot?.windows.map((w) => [w.id, w.usedPercent])).toEqual([
      ['claude:five_hour', 42],
      ['claude:seven_day', 71],
    ])
    expect(snapshot?.windows[0]?.resetsAt).toBe(Date.parse('2023-11-14T23:00:00.000Z'))
  })

  it('treats an API-key session (no rate limits) as "not a subscription"', () => {
    const payload = claudePayload({ rateLimitsAvailable: false, subscriptionType: null })
    expect(normalizeSubscriptionUsage('claude-code', payload, FETCHED_AT)).toBeUndefined()
  })

  it('returns undefined when the fork reported the method as unsupported', () => {
    expect(
      normalizeSubscriptionUsage('claude-code', claudePayload({ supported: false }), FETCHED_AT),
    ).toBeUndefined()
  })

  it('skips a window whose utilization is null rather than rendering it as zero', () => {
    const payload = claudePayload({
      rateLimits: {
        five_hour: { utilization: null, resets_at: '2023-11-14T23:00:00.000Z' },
        seven_day: { utilization: 12 },
      },
    })
    const snapshot = normalizeSubscriptionUsage('claude-code', payload, FETCHED_AT)
    expect(snapshot?.windows.map((w) => w.id)).toEqual(['claude:seven_day'])
    expect(snapshot?.windows[0]?.resetsAt).toBeUndefined()
  })

  it('expands the model-scoped buckets and the extra-usage block', () => {
    const payload = claudePayload({
      rateLimits: {
        five_hour: { utilization: 5 },
        model_scoped: [
          { display_name: 'Opus', utilization: 90, resets_at: '2023-11-15T00:00:00.000Z' },
          { utilization: 50 },
        ],
        extra_usage: { is_enabled: true, used_credits: 4, monthly_limit: 20, currency: 'USD' },
      },
    })
    const snapshot = normalizeSubscriptionUsage('claude-code', payload, FETCHED_AT)
    // The nameless entry has no stable identity, so it is dropped.
    expect(snapshot?.windows.map((w) => w.id)).toEqual(['claude:five_hour', 'claude:model:Opus'])
    expect(snapshot?.extraUsage).toEqual({
      enabled: true,
      usedCredits: 4,
      monthlyLimit: 20,
      currency: 'USD',
    })
  })

  it('returns undefined when no window survived normalization', () => {
    const payload = claudePayload({ rateLimits: { five_hour: { utilization: null } } })
    expect(normalizeSubscriptionUsage('claude-code', payload, FETCHED_AT)).toBeUndefined()
  })
})

describe('normalizeSubscriptionUsage — codex', () => {
  it('maps the single-bucket view with unix-second reset times', () => {
    const snapshot = normalizeSubscriptionUsage('codex', codexPayload(), FETCHED_AT)
    expect(snapshot?.planLabel).toBe('plus')
    expect(snapshot?.windows.map((w) => [w.id, w.usedPercent])).toEqual([
      ['codex:primary', 33],
      ['codex:secondary', 88],
    ])
    expect(snapshot?.windows[0]?.resetsAt).toBe(1_700_003_600_000)
    expect(snapshot?.windows[0]?.label).toBe('5-hour')
    expect(snapshot?.windows[1]?.label).toBe('Weekly')
  })

  it('prefers the per-limit buckets so the same data is not counted twice', () => {
    const payload = codexPayload({
      rateLimitsByLimitId: {
        gpt: {
          limitName: 'GPT-5',
          planType: 'pro',
          primary: { usedPercent: 10, windowDurationMins: 300 },
          secondary: null,
        },
        codex: {
          limitName: 'Codex',
          primary: { usedPercent: 60, windowDurationMins: 10080 },
          secondary: null,
        },
      },
    })
    const snapshot = normalizeSubscriptionUsage('codex', payload, FETCHED_AT)
    expect(snapshot?.windows.map((w) => w.id)).toEqual([
      'codex:limit:gpt:primary',
      'codex:limit:codex:primary',
    ])
    // More than one bucket ⇒ prefix each label with the bucket's name.
    expect(snapshot?.windows[0]?.label).toBe('GPT-5 · 5-hour')
    expect(snapshot?.planLabel).toBe('pro')
  })

  it('parses availableCount from the decimal string the fork sends for a u64', () => {
    const payload = codexPayload({ resetCredits: { availableCount: '3', credits: [] } })
    const snapshot = normalizeSubscriptionUsage('codex', payload, FETCHED_AT)
    expect(snapshot?.resetCredits).toEqual({ availableCount: 3 })
  })

  it('drops an unparseable credit count instead of rendering NaN', () => {
    const payload = codexPayload({ resetCredits: { availableCount: 'many' } })
    expect(normalizeSubscriptionUsage('codex', payload, FETCHED_AT)?.resetCredits).toBeUndefined()
  })

  it('returns undefined when the account is on an API key', () => {
    const payload = codexPayload({ supported: false, rateLimits: null })
    expect(normalizeSubscriptionUsage('codex', payload, FETCHED_AT)).toBeUndefined()
  })
})

describe('normalizeSubscriptionUsage — dispatch', () => {
  it('keys off the payload vendor tag, not the agent id', () => {
    // A custom agent implementing the ext-method lights up the indicator too.
    const snapshot = normalizeSubscriptionUsage('my-agent', claudePayload(), FETCHED_AT)
    expect(snapshot?.agentId).toBe('my-agent')
    expect(snapshot?.windows.length).toBe(2)
  })

  it('ignores an unknown vendor and non-object payloads', () => {
    expect(normalizeSubscriptionUsage('x', { vendor: 'gemini' }, FETCHED_AT)).toBeUndefined()
    expect(normalizeSubscriptionUsage('x', undefined, FETCHED_AT)).toBeUndefined()
    expect(normalizeSubscriptionUsage('x', [], FETCHED_AT)).toBeUndefined()
  })
})

describe('pickTightestWindow', () => {
  it('returns the window closest to being exhausted', () => {
    const snapshot = normalizeSubscriptionUsage('codex', codexPayload(), FETCHED_AT)
    expect(pickTightestWindow(snapshot)?.usedPercent).toBe(88)
  })

  it('returns undefined without a snapshot', () => {
    expect(pickTightestWindow(undefined)).toBeUndefined()
  })
})

describe('isStale', () => {
  const snapshot: SubscriptionUsageSnapshot = {
    agentId: 'codex',
    windows: [{ id: 'w', label: 'w', usedPercent: 10, resetsAt: FETCHED_AT + 60_000 }],
    fetchedAt: FETCHED_AT,
  }

  it('is fresh inside the ttl and before any window rolls over', () => {
    expect(isStale(snapshot, FETCHED_AT + 30_000, 600_000)).toBe(false)
  })

  it('goes stale once older than the ttl', () => {
    expect(isStale(snapshot, FETCHED_AT + 600_001, 600_000)).toBe(true)
  })

  it('goes stale once a window has rolled over, even inside the ttl', () => {
    expect(isStale(snapshot, FETCHED_AT + 60_000, 600_000)).toBe(true)
  })

  it('is never stale without a snapshot', () => {
    expect(isStale(undefined, FETCHED_AT, 1)).toBe(false)
  })
})

describe('resolveUsageDisplay', () => {
  const snapshot: SubscriptionUsageSnapshot = {
    agentId: 'codex',
    windows: [{ id: 'w', label: 'w', usedPercent: 10 }],
    fetchedAt: FETCHED_AT,
  }

  it('shows the subscription readout whenever a snapshot exists', () => {
    expect(resolveUsageDisplay({ snapshot })).toBe('subscription')
  })

  it('hides the indicator when neither readout applies', () => {
    expect(resolveUsageDisplay({ snapshot: undefined })).toBe('hidden')
  })

  describe('account', () => {
    const account: AccountUsageState = {
      hasSource: true,
      usage: { kind: 'balance', remainingUSD: 1, fetchedAt: FETCHED_AT },
    }
    const unavailable: AccountUsageState = { hasSource: true }
    const noSource: AccountUsageState = { hasSource: false }

    it('shows the account readout when a source is declared', () => {
      expect(
        resolveUsageDisplay({
          snapshot: undefined,
          account,
        }),
      ).toBe('account')
    })

    it('shows unavailable rather than hiding when the number is missing', () => {
      expect(
        resolveUsageDisplay({
          snapshot: undefined,
          account: unavailable,
        }),
      ).toBe('unavailable')
    })

    it('prefers the subscription snapshot over the account readout', () => {
      expect(
        resolveUsageDisplay({
          snapshot,
          account,
        }),
      ).toBe('subscription')
    })

    it('treats an account without a source the same as no account at all', () => {
      expect(
        resolveUsageDisplay({
          snapshot: undefined,
          account: noSource,
        }),
      ).toBe('hidden')
    })
  })
})
