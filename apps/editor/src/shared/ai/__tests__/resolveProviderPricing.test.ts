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

  it('strips a trailing context hint to reach the bare catalog entry', () => {
    const result = resolveModelPricing({
      bareModel: 'acme-chat-flash[1m]',
      pricingSource: { id: 'catalog', options: { vendor: 'deepseek' } },
    })
    expect(result.origin).toBe('catalog')
    expect(result.pricing?.input).toBe(1)
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

// The agent reports usage under the model id it ran with, context hint and all
// (`acme-chat-pro[1m]`), while a gateway table is normally keyed by the bare
// name. An exact-only lookup missed, and the session fell back to the CLI's
// Anthropic-tier guess — off by more than 4x against the gateway's own rate.
describe('resolveModelPricing — trailing context hints', () => {
  const LANE: AiRateTable = {
    'acme-chat-pro': { currency: 'CNY', input: 9, output: 27, cacheRead: 0.2997 },
    'acme-chat-pro[1m]': { currency: 'CNY', input: 18, output: 54, cacheRead: 0.6 },
  }

  it('prefers an exact lane entry over the bare name', () => {
    const result = resolveModelPricing({
      bareModel: 'acme-chat-pro[1m]',
      pricingSource: { id: 'http-json' },
      gatewayRates: LANE,
    })
    expect(result).toEqual({ pricing: LANE['acme-chat-pro[1m]'], origin: 'gateway' })
  })

  it('falls back to the bare name when the table prices no separate lane', () => {
    const bareOnly: AiRateTable = { 'acme-chat-pro': LANE['acme-chat-pro']! }
    const result = resolveModelPricing({
      bareModel: 'acme-chat-pro[1m]',
      pricingSource: { id: 'http-json' },
      gatewayRates: bareOnly,
    })
    expect(result).toEqual({ pricing: bareOnly['acme-chat-pro'], origin: 'gateway' })
  })

  // Gateway keys are copied verbatim out of remote JSON, so lower-casing the
  // lookup would newly miss a capitalized key. The fallback strips the hint only.
  it('does not lower-case the key while stripping the hint', () => {
    expect(
      resolveModelPricing({
        bareModel: 'acme-chat-pro[1m]',
        pricingSource: { id: 'http-json' },
        gatewayRates: { 'Acme-Chat-Pro': { input: 9, output: 27 } },
      }),
    ).toEqual({})
  })

  // Date snapshots are part of the id in the catalog tables, so they survive.
  it('keeps a trailing date snapshot when stripping the hint', () => {
    const result = resolveModelPricing({
      bareModel: 'claude-opus-4-20250514[1m]',
      pricingSource: { id: 'http-json' },
      gatewayRates: { 'claude-opus-4-20250514': { input: 7, output: 8 } },
    })
    expect(result).toEqual({ pricing: { input: 7, output: 8 }, origin: 'gateway' })
  })
})
