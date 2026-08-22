/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { estimateCodexCost, repriceForeignModelBreakdown } from '../acpSessionCost.js'
import type { AcpModelCost } from '../acpSessionModel.js'
import type { CodexModelUsage } from '../../../../../shared/ai/codexUsage.js'

function row(partial: Partial<AcpModelCost> & { model: string }): AcpModelCost {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreateTokens: 0,
    costUSD: 0,
    ...partial,
  }
}

function codexUsage(model: string, partial?: Partial<CodexModelUsage>): CodexModelUsage {
  return {
    model,
    inputTokens: 0,
    cachedReadTokens: 0,
    outputTokens: 0,
    ...partial,
  }
}

describe('repriceForeignModelBreakdown', () => {
  it('returns undefined for an empty breakdown', () => {
    expect(repriceForeignModelBreakdown([])).toBeUndefined()
  })

  it('returns undefined when no row resolves a rate (CLI cost stays authoritative)', () => {
    expect(
      repriceForeignModelBreakdown([row({ model: 'totally-unknown-model', costUSD: 0.42 })]),
    ).toBeUndefined()
  })

  it('re-prices a deepseek row from token counts via the built-in catalog', () => {
    const result = repriceForeignModelBreakdown([
      row({
        model: 'deepseek-v4-flash[1m]',
        inputTokens: 1_000_000,
        cacheReadTokens: 500_000,
        outputTokens: 100_000,
        costUSD: 9.99, // inflated by the CLI's flagship-tier fallback
      }),
    ])
    // deepseek-v4-flash (CNY): input 1 / cacheRead 0.2 / output 2 per M, at 7.2.
    const expected = (1_000_000 * 1 + 500_000 * 0.2 + 100_000 * 2) / 7.2 / 1e6
    expect(result).toBeDefined()
    expect(result!.cost).toEqual({ amount: expected, currency: 'USD' })
    expect(result!.models).toHaveLength(1)
    expect(result!.models[0]!.costUSD).toBeCloseTo(expected, 10)
  })

  it('mixes an Anthropic row (CLI figure kept) with a re-priced foreign row', () => {
    const result = repriceForeignModelBreakdown([
      row({ model: 'claude-sonnet-5', inputTokens: 1_000_000, costUSD: 0.42 }),
      row({ model: 'kimi-k2.6', inputTokens: 1_000_000, costUSD: 30 }),
    ])
    // kimi-k2.6 (CNY): input 6.5 per M at 7.2. The claude row keeps the CLI figure.
    const kimiCost = 6.5 / 7.2
    expect(result!.models[0]!.costUSD).toBe(0.42)
    expect(result!.models[1]!.costUSD).toBeCloseTo(kimiCost, 10)
    expect(result!.cost!.amount).toBeCloseTo(0.42 + kimiCost, 10)
  })

  it('leaves a pure-Anthropic breakdown alone — the CLI cost stays authoritative', () => {
    expect(
      repriceForeignModelBreakdown([
        row({ model: 'claude-opus-4-20250514', inputTokens: 1_000_000, costUSD: 0.42 }),
      ]),
    ).toBeUndefined()
  })

  it('lets a user-configured rate override the CLI figure for an Anthropic model', () => {
    const result = repriceForeignModelBreakdown(
      [row({ model: 'claude-opus-4', inputTokens: 1_000_000, costUSD: 0.42 })],
      {
        key: 'anthropic/gw',
        type: 'anthropic',
        name: 'gw',
        gatewayRates: { 'claude-opus-4': { input: 1, output: 2 } },
      },
    )
    expect(result!.models[0]!.costUSD).toBeCloseTo(1, 10)
    expect(result!.cost!.amount).toBeCloseTo(1, 10)
  })
})

describe('estimateCodexCost', () => {
  it('returns undefined for an empty usage snapshot', () => {
    expect(estimateCodexCost([])).toBeUndefined()
  })

  it('leaves costUSD undefined and totals nothing when the model rate is unknown', () => {
    const result = estimateCodexCost([
      codexUsage('unknown-model', { inputTokens: 1_000_000, outputTokens: 100_000 }),
    ])
    expect(result).toBeDefined()
    expect(result!.cost).toBeUndefined()
    expect(result!.models).toHaveLength(1)
    expect(result!.models[0]!.costUSD).toBeUndefined()
  })

  it('prices a known model through the built-in catalog', () => {
    const result = estimateCodexCost([
      codexUsage('gpt-5.4', { inputTokens: 1_000_000, outputTokens: 100_000 }),
    ])
    // gpt-5.4: input 2.5 / output 15 per M → 2.5 + 1.5 = 4.
    expect(result!.cost).toEqual({ amount: 4, currency: 'USD' })
    expect(result!.models[0]!.costUSD).toBeCloseTo(4, 10)
  })

  it('only accumulates rows with a resolvable rate', () => {
    const result = estimateCodexCost([
      codexUsage('gpt-5.4', { inputTokens: 1_000_000, outputTokens: 100_000 }),
      codexUsage('unknown-model', { inputTokens: 500_000 }),
    ])
    expect(result!.cost).toEqual({ amount: 4, currency: 'USD' })
    expect(result!.models).toHaveLength(2)
    expect(result!.models[1]!.costUSD).toBeUndefined()
  })
})
