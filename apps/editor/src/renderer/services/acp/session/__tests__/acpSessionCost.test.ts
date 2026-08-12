/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { repriceForeignModelBreakdown } from '../acpSessionCost.js'
import type { AcpModelCost } from '../acpSessionModel.js'

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

describe('repriceForeignModelBreakdown', () => {
  it('returns undefined for pure-claude breakdowns (CLI cost stays authoritative)', () => {
    expect(
      repriceForeignModelBreakdown([
        row({ model: 'claude-opus-4-20250514', costUSD: 0.42 }),
        row({ model: 'claude-sonnet-5[1m]', costUSD: 0.1 }),
      ]),
    ).toBeUndefined()
  })

  it('returns undefined for an empty breakdown', () => {
    expect(repriceForeignModelBreakdown([])).toBeUndefined()
  })

  it('re-prices a deepseek row from token counts and marks the total estimated', () => {
    const result = repriceForeignModelBreakdown([
      row({
        model: 'deepseek-v4-flash[1m]',
        inputTokens: 1_000_000,
        cacheReadTokens: 500_000,
        outputTokens: 100_000,
        costUSD: 9.99, // inflated by the CLI's flagship-tier fallback
      }),
    ])
    // ¥1 in / ¥0.2 cacheRead / ¥2 out per M, converted at 7.2:
    // (1e6·1 + 5e5·0.2 + 1e5·2) / 7.2 / 1e6
    const expected = 1.3 / 7.2
    expect(result).toBeDefined()
    expect(result!.cost.amount).toBeCloseTo(expected, 10)
    expect(result!.cost.currency).toBe('USD')
    expect(result!.models).toHaveLength(1)
    expect(result!.models[0]!.costUSD).toBeCloseTo(expected, 10)
    expect(result!.models[0]!.model).toBe('deepseek-v4-flash[1m]')
  })

  it('re-prices unknown gateway ids at the deepseek-pro fallback tier', () => {
    const result = repriceForeignModelBreakdown([
      row({ model: 'deepseek-v5', inputTokens: 1_000_000, costUSD: 50 }),
    ])
    // ¥12 in per M at 7.2
    expect(result!.cost.amount).toBeCloseTo(12 / 7.2, 10)
  })

  it('keeps the CLI figure for claude rows in a mixed breakdown and re-aggregates', () => {
    const result = repriceForeignModelBreakdown([
      row({ model: 'claude-sonnet-5', costUSD: 0.42 }),
      row({
        model: 'kimi-k3',
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        costUSD: 30,
      }),
    ])
    // kimi-k3: (1e6·20 + 1e5·100) / 7.2 / 1e6 = 30/7.2
    const kimiCost = 30 / 7.2
    expect(result!.models[0]!.costUSD).toBe(0.42)
    expect(result!.models[1]!.costUSD).toBeCloseTo(kimiCost, 10)
    expect(result!.cost.amount).toBeCloseTo(0.42 + kimiCost, 10)
  })
})
