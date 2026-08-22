/*---------------------------------------------------------------------------------------------
 *  Tests for packages/platform/src/ai/aiModelPricing.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { CNY_PER_USD, estimateCostUSD, isSamePricing } from '../../ai/aiModelPricing.js'

describe('estimateCostUSD', () => {
  it('sums all four buckets', () => {
    const pricing = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }
    const tally = { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 1e6 }
    expect(estimateCostUSD(pricing, tally)).toBe(10)
  })

  it('bills missing cacheRead/cacheWrite at the input rate', () => {
    const pricing = { input: 1, output: 2 }
    const tally = { input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 1e6 }
    expect(estimateCostUSD(pricing, tally)).toBe(5)
  })

  it('ignores absent cache tally fields', () => {
    const pricing = { input: 1, output: 2 }
    const tally = { input: 1e6, output: 1e6 }
    expect(estimateCostUSD(pricing, tally)).toBe(3)
  })

  it('normalizes CNY to USD', () => {
    const tally = { input: 1e6, output: 1e6 }
    expect(
      estimateCostUSD({ currency: 'CNY', input: CNY_PER_USD, output: CNY_PER_USD }, tally),
    ).toBe(2)
  })
})

describe('isSamePricing', () => {
  it('treats both-undefined as equal', () => {
    expect(isSamePricing(undefined, undefined)).toBe(true)
    expect(isSamePricing(undefined, { input: 1, output: 2 })).toBe(false)
    expect(isSamePricing({ input: 1, output: 2 }, undefined)).toBe(false)
  })

  it('compares effective rates', () => {
    expect(isSamePricing({ input: 1, output: 2 }, { input: 1, output: 2 })).toBe(true)
    expect(isSamePricing({ input: 1, output: 2 }, { input: 2, output: 2 })).toBe(false)
  })

  it('normalizes missing cache fields and currency', () => {
    expect(
      isSamePricing({ input: 1, output: 2 }, { input: 1, output: 2, cacheRead: 1, cacheWrite: 1 }),
    ).toBe(true)
    expect(isSamePricing({ input: 1, output: 2 }, { input: 1, output: 2, currency: 'USD' })).toBe(
      true,
    )
    expect(isSamePricing({ input: 1, output: 2 }, { input: 1, output: 2, currency: 'CNY' })).toBe(
      false,
    )
  })
})
