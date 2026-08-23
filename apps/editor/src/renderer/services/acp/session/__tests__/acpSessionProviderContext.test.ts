/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import type { AiModelPricing, AiRemoteSourceSpec } from '@universe-editor/platform'
import { priceSessionModel, type SessionProviderContext } from '../acpSessionProviderContext.js'

const GATEWAY_PRICING: AiModelPricing = { input: 3, output: 4 }

const CATALOG_ANTHROPIC: AiRemoteSourceSpec = { id: 'catalog', options: { vendor: 'anthropic' } }
const CATALOG_UNKNOWN_VENDOR: AiRemoteSourceSpec = { id: 'catalog', options: { vendor: 'acme' } }
const GATEWAY_SOURCE: AiRemoteSourceSpec = { id: 'https://rates.example.com/pricing.json' }

function ctx(partial?: Partial<SessionProviderContext>): SessionProviderContext {
  return { providerId: 'gw', protocol: 'anthropic-messages', ...partial }
}

describe('priceSessionModel', () => {
  it('is unknown when there is no provider context — never a cross-vendor fallback', () => {
    expect(priceSessionModel('claude-sonnet-5', undefined)).toEqual({})
    expect(priceSessionModel('made-up-model', undefined)).toEqual({})
  })

  it('resolves through the declared catalog source against its vendor', () => {
    const result = priceSessionModel('claude-sonnet-5', ctx({ pricingSource: CATALOG_ANTHROPIC }))
    expect(result.origin).toBe('catalog')
    expect(result.pricing?.input).toBe(3)
    expect(result.pricing?.output).toBe(15)
  })

  it('returns {} for a catalog source with an unknown vendor', () => {
    expect(
      priceSessionModel('claude-sonnet-5', ctx({ pricingSource: CATALOG_UNKNOWN_VENDOR })),
    ).toEqual({})
  })

  it('returns {} for a catalog source whose vendor lacks the model', () => {
    expect(priceSessionModel('made-up-model', ctx({ pricingSource: CATALOG_ANTHROPIC }))).toEqual(
      {},
    )
  })

  it('resolves a gateway source through the gateway rate table', () => {
    const result = priceSessionModel(
      'kimi-k3',
      ctx({ pricingSource: GATEWAY_SOURCE, gatewayRates: { 'kimi-k3': GATEWAY_PRICING } }),
    )
    expect(result).toEqual({ pricing: GATEWAY_PRICING, origin: 'gateway' })
  })

  it('returns {} when the gateway table lacks the model', () => {
    expect(
      priceSessionModel('made-up-model', ctx({ pricingSource: GATEWAY_SOURCE, gatewayRates: {} })),
    ).toEqual({})
  })

  it('returns {} when a gateway source has no mirrored rate table', () => {
    expect(priceSessionModel('kimi-k3', ctx({ pricingSource: GATEWAY_SOURCE }))).toEqual({})
  })

  it('ignores a gateway rate table when no pricing source is declared', () => {
    expect(
      priceSessionModel('kimi-k3', ctx({ gatewayRates: { 'kimi-k3': GATEWAY_PRICING } })),
    ).toEqual({})
  })
})
