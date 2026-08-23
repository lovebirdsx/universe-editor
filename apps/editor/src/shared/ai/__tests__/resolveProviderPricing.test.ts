/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  resolveProviderPricing: the rate for a model comes only from the provider's
 *  declared pricingSource. No source = unknown, never a cross-provider fallback.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import type { AiRateTable } from '@universe-editor/platform'
import { resolveModelPricing } from '../resolveProviderPricing.js'

const GATEWAY: AiRateTable = { 'claude-sonnet-5': { input: 99, output: 99 } }

describe('resolveModelPricing — no pricingSource', () => {
  it('returns {} when the source is omitted', () => {
    expect(resolveModelPricing({ bareModel: 'claude-sonnet-5' })).toEqual({})
  })

  it('returns {} even when a known catalog model is asked for', () => {
    expect(resolveModelPricing({ bareModel: 'gpt-5.4' })).toEqual({})
  })

  it('returns {} even when gatewayRates happen to contain the model', () => {
    expect(resolveModelPricing({ bareModel: 'claude-sonnet-5', gatewayRates: GATEWAY })).toEqual({})
  })

  it('returns {} with no pricing and no origin, not a fallback number', () => {
    const result = resolveModelPricing({ bareModel: 'claude-opus-4-8' })
    expect(result.pricing).toBeUndefined()
    expect(result.origin).toBeUndefined()
  })
})

describe('resolveModelPricing — catalog source', () => {
  it('hits the anthropic official table by bare model id', () => {
    const result = resolveModelPricing({
      bareModel: 'claude-sonnet-5',
      pricingSource: { id: 'catalog', options: { vendor: 'anthropic' } },
    })
    expect(result).toEqual({
      pricing: { input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 },
      origin: 'catalog',
    })
  })

  it('hits the openai official table', () => {
    const result = resolveModelPricing({
      bareModel: 'gpt-5.4',
      pricingSource: { id: 'catalog', options: { vendor: 'openai' } },
    })
    expect(result).toEqual({
      pricing: { input: 2.5, output: 15, cacheRead: 0.25 },
      origin: 'catalog',
    })
  })

  it('returns {} when the bare model is not in that vendor table', () => {
    expect(
      resolveModelPricing({
        bareModel: 'claude-sonnet-5',
        pricingSource: { id: 'catalog', options: { vendor: 'openai' } },
      }),
    ).toEqual({})
  })

  // The vendor is a property of the channel, not of the model: a catalog source
  // that names no vendor resolves nothing, even for an official model whose
  // vendor is obvious. Both call sites must agree, and the session-cost path
  // only ever knows a bare wire name.
  it('returns {} when the catalog source names no vendor', () => {
    expect(
      resolveModelPricing({ bareModel: 'claude-sonnet-5', pricingSource: { id: 'catalog' } }),
    ).toEqual({})
  })

  it('never falls back to gatewayRates', () => {
    expect(
      resolveModelPricing({
        bareModel: 'claude-sonnet-5',
        pricingSource: { id: 'catalog', options: { vendor: 'deepseek' } },
        gatewayRates: GATEWAY,
      }),
    ).toEqual({})
  })
})

describe('resolveModelPricing — gateway source', () => {
  it('hits gatewayRates for a non-catalog source id', () => {
    const result = resolveModelPricing({
      bareModel: 'claude-sonnet-5',
      pricingSource: { id: 'http-json' },
      gatewayRates: GATEWAY,
    })
    expect(result).toEqual({ pricing: { input: 99, output: 99 }, origin: 'gateway' })
  })

  it('returns {} when the model is absent from gatewayRates', () => {
    expect(
      resolveModelPricing({
        bareModel: 'made-up',
        pricingSource: { id: 'http-json' },
        gatewayRates: GATEWAY,
      }),
    ).toEqual({})
  })

  it('never falls back to the official catalog', () => {
    expect(
      resolveModelPricing({
        bareModel: 'claude-sonnet-5',
        pricingSource: { id: 'http-json' },
      }),
    ).toEqual({})
  })
})
