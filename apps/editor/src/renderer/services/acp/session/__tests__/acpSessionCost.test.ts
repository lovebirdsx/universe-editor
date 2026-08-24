/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { estimateCodexCost, repriceForeignModelBreakdown } from '../acpSessionCost.js'
import type { AcpModelCost } from '../acpSessionModel.js'
import type { SessionProviderContext } from '../acpSessionProviderContext.js'
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

/** A mid-turn row: token counts with no CLI cost figure at all. */
function midturnRow(partial: Partial<AcpModelCost> & { model: string }): AcpModelCost {
  const { costUSD: _ignored, ...rest } = row(partial)
  return rest
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
    const ctx: SessionProviderContext = {
      providerId: 'gw',
      protocol: 'anthropic-messages',
      pricingSource: { id: 'catalog', options: { vendor: 'deepseek' } },
    }
    const result = repriceForeignModelBreakdown(
      [
        row({
          model: 'deepseek-v4-flash',
          inputTokens: 1_000_000,
          cacheReadTokens: 500_000,
          outputTokens: 100_000,
          costUSD: 9.99, // inflated by the CLI's flagship-tier fallback
        }),
      ],
      ctx,
    )
    // deepseek-v4-flash (CNY): input 1 / cacheRead 0.2 / output 2 per M, at 7.2.
    const expected = (1_000_000 * 1 + 500_000 * 0.2 + 100_000 * 2) / 7.2 / 1e6
    expect(result).toBeDefined()
    expect(result!.cost).toEqual({ amount: expected, currency: 'USD' })
    expect(result!.models).toHaveLength(1)
    expect(result!.models[0]!.costUSD).toBeCloseTo(expected, 10)
  })

  it('mixes an Anthropic row (CLI figure kept) with a re-priced foreign row', () => {
    const ctx: SessionProviderContext = {
      providerId: 'gw',
      protocol: 'anthropic-messages',
      pricingSource: { id: 'catalog', options: { vendor: 'moonshot' } },
    }
    const result = repriceForeignModelBreakdown(
      [
        row({ model: 'claude-sonnet-5', inputTokens: 1_000_000, costUSD: 0.42 }),
        row({ model: 'kimi-k2.6', inputTokens: 1_000_000, costUSD: 30 }),
      ],
      ctx,
    )
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
        providerId: 'gw',
        protocol: 'anthropic-messages',
        pricingSource: { id: 'http-json', options: {} },
        gatewayRates: { 'claude-opus-4': { input: 1, output: 2 } },
      },
    )
    expect(result!.models[0]!.costUSD).toBeCloseTo(1, 10)
    expect(result!.cost!.amount).toBeCloseTo(1, 10)
  })

  it('returns undefined when the provider has no pricingSource (CLI figure stays)', () => {
    const result = repriceForeignModelBreakdown(
      [row({ model: 'kimi-k2.6', inputTokens: 1_000_000, costUSD: 30 })],
      { providerId: 'gw', protocol: 'anthropic-messages' },
    )
    expect(result).toBeUndefined()
  })

  // The agent reports usage under `deepseek-v4-pro[1m]` while the gateway prices
  // the bare name. An exact-only lookup missed and the CLI's Anthropic-tier guess
  // survived — the figure users saw was over 4x the gateway's own charge.
  it('re-prices a lane-suffixed model against the bare gateway entry', () => {
    const result = repriceForeignModelBreakdown(
      [
        row({
          model: 'deepseek-v4-pro[1m]',
          inputTokens: 1_000_000,
          cacheReadTokens: 500_000,
          outputTokens: 100_000,
          costUSD: 9.99, // the CLI's inflated flagship-tier figure
        }),
      ],
      {
        providerId: 'gw',
        protocol: 'anthropic-messages',
        pricingSource: { id: 'http-json', options: {} },
        gatewayRates: {
          'deepseek-v4-pro': { currency: 'CNY', input: 9, output: 27, cacheRead: 0.2997 },
        },
      },
    )
    const expected = (1_000_000 * 9 + 500_000 * 0.2997 + 100_000 * 27) / 7.2 / 1e6
    expect(result!.models[0]!.costUSD).toBeCloseTo(expected, 10)
    expect(result!.cost!.amount).toBeCloseTo(expected, 10)
  })

  // A CNY-priced gateway is normalized to USD here and converted back to CNY by
  // the UI. Both directions have to use the same rate or the figure skews.
  it('normalizes a CNY gateway rate with the live rate from the context', () => {
    const result = repriceForeignModelBreakdown(
      [row({ model: 'deepseek-v4-pro', inputTokens: 1_000_000, costUSD: 9.99 })],
      {
        providerId: 'gw',
        protocol: 'anthropic-messages',
        pricingSource: { id: 'http-json', options: {} },
        gatewayRates: { 'deepseek-v4-pro': { currency: 'CNY', input: 9, output: 27 } },
        cnyPerUsd: 6.74,
      },
    )
    expect(result!.models[0]!.costUSD).toBeCloseTo(9 / 6.74, 10)
  })

  // A lane-suffixed Anthropic model on a `catalog` provider keeps the CLI figure:
  // stripping the hint resolves the standard tier, but `origin === 'catalog'` means
  // trustCli still holds, so the CLI's own lane pricing (1M is 2x) is not clobbered.
  it('keeps the CLI figure for a lane-suffixed Anthropic model on a catalog source', () => {
    expect(
      repriceForeignModelBreakdown(
        [row({ model: 'claude-sonnet-5[1m]', inputTokens: 1_000_000, costUSD: 6 })],
        {
          providerId: 'official',
          protocol: 'anthropic-messages',
          pricingSource: { id: 'catalog', options: { vendor: 'anthropic' } },
        },
      ),
    ).toBeUndefined()
  })

  // On a reselling gateway the published rate wins even via the stripped-hint
  // fallback: the gateway is what actually bills, and its table describes this
  // deployment better than the CLI's Anthropic-tier arithmetic.
  it('lets a reselling gateway rate win for a lane-suffixed Anthropic model', () => {
    const result = repriceForeignModelBreakdown(
      [row({ model: 'claude-sonnet-5[1m]', inputTokens: 1_000_000, costUSD: 6 })],
      {
        providerId: 'gw',
        protocol: 'anthropic-messages',
        pricingSource: { id: 'http-json', options: {} },
        gatewayRates: { 'claude-sonnet-5': { input: 2, output: 10 } },
      },
    )
    expect(result!.models[0]!.costUSD).toBeCloseTo(2, 10)
  })
  // Mid-turn rows carry token counts with no costUSD (only the turn-final
  // `result` knows the CLI figure). They must be priced locally whenever a rate
  // resolves — that is what makes the readout advance during a running turn.
  it('prices a mid-turn Anthropic row locally when the CLI reported no cost', () => {
    const result = repriceForeignModelBreakdown(
      [midturnRow({ model: 'claude-sonnet-5', inputTokens: 1_000_000 })],
      {
        providerId: 'official',
        protocol: 'anthropic-messages',
        pricingSource: { id: 'catalog', options: { vendor: 'anthropic' } },
      },
    )
    expect(result).toBeDefined()
    expect(result!.models[0]!.costUSD).toBeGreaterThan(0)
  })

  it('leaves a mid-turn row unpriced when the session has no rate table', () => {
    // Official subscription sessions resolve no provider context at all: the
    // honest answer is "—", never a guessed catalog price.
    expect(
      repriceForeignModelBreakdown([
        midturnRow({ model: 'claude-sonnet-5', inputTokens: 1_000_000 }),
      ]),
    ).toBeUndefined()
  })

  it('prices a mid-turn gateway row from the gateway table', () => {
    const result = repriceForeignModelBreakdown(
      [midturnRow({ model: 'deepseek-v4-pro[1m]', inputTokens: 1_000_000 })],
      {
        providerId: 'gw',
        protocol: 'anthropic-messages',
        pricingSource: { id: 'http-json', options: {} },
        gatewayRates: { 'deepseek-v4-pro': { currency: 'CNY', input: 9, output: 27 } },
        cnyPerUsd: 6.74,
      },
    )
    expect(result!.models[0]!.costUSD).toBeCloseTo(9 / 6.74, 10)
  })

  it('keeps a CLI figure on one row while pricing a mid-turn row on another', () => {
    const result = repriceForeignModelBreakdown(
      [
        row({ model: 'claude-sonnet-5', inputTokens: 1_000_000, costUSD: 0.42 }),
        midturnRow({ model: 'claude-haiku-4-5', inputTokens: 1_000_000 }),
      ],
      {
        providerId: 'official',
        protocol: 'anthropic-messages',
        pricingSource: { id: 'catalog', options: { vendor: 'anthropic' } },
      },
    )
    expect(result!.models[0]!.costUSD).toBe(0.42)
    expect(result!.models[1]!.costUSD).toBeGreaterThan(0)
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
    const ctx: SessionProviderContext = {
      providerId: 'openai',
      protocol: 'openai-responses',
      pricingSource: { id: 'catalog', options: { vendor: 'openai' } },
    }
    const result = estimateCodexCost(
      [codexUsage('gpt-5.4', { inputTokens: 1_000_000, outputTokens: 100_000 })],
      ctx,
    )
    // gpt-5.4: input 2.5 / output 15 per M → 2.5 + 1.5 = 4.
    expect(result!.cost).toEqual({ amount: 4, currency: 'USD' })
    expect(result!.models[0]!.costUSD).toBeCloseTo(4, 10)
  })

  it('only accumulates rows with a resolvable rate', () => {
    const ctx: SessionProviderContext = {
      providerId: 'openai',
      protocol: 'openai-responses',
      pricingSource: { id: 'catalog', options: { vendor: 'openai' } },
    }
    const result = estimateCodexCost(
      [
        codexUsage('gpt-5.4', { inputTokens: 1_000_000, outputTokens: 100_000 }),
        codexUsage('unknown-model', { inputTokens: 500_000 }),
      ],
      ctx,
    )
    expect(result!.cost).toEqual({ amount: 4, currency: 'USD' })
    expect(result!.models).toHaveLength(2)
    expect(result!.models[1]!.costUSD).toBeUndefined()
  })

  it('resolves no rate without a provider context — even for an official catalog model', () => {
    const result = estimateCodexCost([
      codexUsage('gpt-5.4', { inputTokens: 1_000_000, outputTokens: 100_000 }),
    ])
    expect(result).toBeDefined()
    expect(result!.cost).toBeUndefined()
    expect(result!.models).toHaveLength(1)
    expect(result!.models[0]!.costUSD).toBeUndefined()
  })

  it('normalizes a CNY rate with the live rate from the context', () => {
    const result = estimateCodexCost([codexUsage('deepseek-v4-pro', { inputTokens: 1_000_000 })], {
      providerId: 'gw',
      protocol: 'openai-responses',
      pricingSource: { id: 'http-json', options: {} },
      gatewayRates: { 'deepseek-v4-pro': { currency: 'CNY', input: 9, output: 27 } },
      cnyPerUsd: 6.74,
    })
    expect(result!.models[0]!.costUSD).toBeCloseTo(9 / 6.74, 10)
  })
})
