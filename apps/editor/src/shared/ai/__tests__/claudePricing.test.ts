/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { claudeModelFamily, claudeModelPricing, estimateClaudeCostUSD } from '../claudePricing.js'

describe('claudeModelFamily', () => {
  it('matches the tier token anywhere in the id', () => {
    expect(claudeModelFamily('claude-fable-5')).toBe('claude-fable')
    expect(claudeModelFamily('claude-opus-4-8')).toBe('claude-opus')
    expect(claudeModelFamily('claude-sonnet-5')).toBe('claude-sonnet')
    expect(claudeModelFamily('claude-haiku-4-5-20251001')).toBe('claude-haiku')
    expect(claudeModelFamily('claude-3-5-haiku-20241022')).toBe('claude-haiku')
  })

  it('ignores case and context-hint suffixes', () => {
    expect(claudeModelFamily('Claude-Opus-4-8[1m]')).toBe('claude-opus')
    expect(claudeModelFamily('claude-sonnet-5[1m]')).toBe('claude-sonnet')
  })

  it('matches kimi gateway ids on their generation token', () => {
    expect(claudeModelFamily('kimi-k3')).toBe('kimi-k3')
    expect(claudeModelFamily('kimi-k2.6')).toBe('kimi-k2')
    expect(claudeModelFamily('kimi-k2-6')).toBe('kimi-k2')
    expect(claudeModelFamily('kimi-k2.7-code')).toBe('kimi-k2')
    expect(claudeModelFamily('Kimi-K2.6')).toBe('kimi-k2')
  })

  it('resolves unknown kimi ids to the current kimi flagship', () => {
    expect(claudeModelFamily('kimi-k9')).toBe('kimi-k3')
  })

  it('falls back to the default family for unknown ids', () => {
    expect(claudeModelFamily('some-future-model')).toBe('claude-sonnet')
  })
})

describe('claudeModelPricing', () => {
  it('returns the family tier', () => {
    expect(claudeModelPricing('claude-opus-4-8').output).toBe(25)
    expect(claudeModelPricing('claude-fable-5').output).toBe(50)
    expect(claudeModelPricing('claude-haiku-4-5').input).toBe(1)
  })

  it('converts kimi CNY list prices to USD at 7.2', () => {
    const k2 = claudeModelPricing('kimi-k2.7-code')
    expect(k2.input).toBeCloseTo(6.5 / 7.2, 9)
    expect(k2.cacheWrite).toBe(k2.input)
    expect(k2.cacheRead).toBeCloseTo(1.3 / 7.2, 9)
    expect(k2.output).toBeCloseTo(27 / 7.2, 9)

    const k3 = claudeModelPricing('kimi-k3')
    expect(k3.input).toBeCloseTo(20 / 7.2, 9)
    expect(k3.cacheWrite).toBe(k3.input)
    expect(k3.cacheRead).toBeCloseTo(2 / 7.2, 9)
    expect(k3.output).toBeCloseTo(100 / 7.2, 9)
  })
})

describe('estimateClaudeCostUSD', () => {
  it('prices each token tier per 1M', () => {
    // opus: 1M input @5 + 1M cacheWrite @6.25 + 1M cacheRead @0.5 + 1M output @25
    const cost = estimateClaudeCostUSD('claude-opus-4-8', {
      inputTokens: 1_000_000,
      cacheCreateTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      outputTokens: 1_000_000,
    })
    expect(cost).toBeCloseTo(5 + 6.25 + 0.5 + 25, 5)
  })

  it('scales sub-1M tallies linearly', () => {
    const cost = estimateClaudeCostUSD('claude-sonnet-5', {
      inputTokens: 10_000,
      cacheCreateTokens: 0,
      cacheReadTokens: 100_000,
      outputTokens: 5_000,
    })
    // 10k @3 + 100k @0.3 + 5k @15 = 0.03 + 0.03 + 0.075
    expect(cost).toBeCloseTo(0.135, 6)
  })

  it('is zero for an empty tally', () => {
    expect(
      estimateClaudeCostUSD('claude-opus-4-8', {
        inputTokens: 0,
        cacheCreateTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
      }),
    ).toBe(0)
  })

  it('prices kimi tokens against the converted CNY rates', () => {
    // kimi-k3: 1M input @20 + 1M cacheRead @2 + 1M output @100 CNY
    const cost = estimateClaudeCostUSD('kimi-k3', {
      inputTokens: 1_000_000,
      cacheCreateTokens: 0,
      cacheReadTokens: 1_000_000,
      outputTokens: 1_000_000,
    })
    expect(cost).toBeCloseTo((20 + 2 + 100) / 7.2, 5)
  })
})
