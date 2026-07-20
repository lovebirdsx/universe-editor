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
})
