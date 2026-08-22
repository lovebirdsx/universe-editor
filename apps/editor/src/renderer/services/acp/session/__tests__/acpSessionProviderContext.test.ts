/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import type { AiModelPricing } from '@universe-editor/platform'
import { priceSessionModel, type SessionProviderContext } from '../acpSessionProviderContext.js'

const GATEWAY_PRICING: AiModelPricing = { input: 3, output: 4 }
const DECLARED_PRICING: AiModelPricing = { input: 7, output: 8 }
const TYPE_PRICING: AiModelPricing = { input: 5, output: 6 }

function ctx(partial?: Partial<SessionProviderContext>): SessionProviderContext {
  return { key: 'anthropic/gw', type: 'anthropic', name: 'gw', ...partial }
}

describe('priceSessionModel', () => {
  it('resolves through the built-in catalog when there is no provider context', () => {
    const result = priceSessionModel('claude-sonnet-5', undefined)
    expect(result.origin).toBe('catalog')
    expect(result.pricing?.input).toBe(3)
  })

  it('returns {} for an unknown model with no context', () => {
    expect(priceSessionModel('made-up-model', undefined)).toEqual({})
  })

  it('prefers the gateway rate table when the context has one', () => {
    const result = priceSessionModel(
      'kimi-k3',
      ctx({ gatewayRates: { 'kimi-k3': GATEWAY_PRICING } }),
    )
    expect(result).toEqual({ pricing: GATEWAY_PRICING, origin: 'gateway' })
  })

  it('prefers a hand-declared model over the gateway table', () => {
    const result = priceSessionModel(
      'kimi-k3',
      ctx({
        declaredModels: [{ id: 'kimi-k3', pricing: DECLARED_PRICING }],
        gatewayRates: { 'kimi-k3': GATEWAY_PRICING },
      }),
    )
    expect(result).toEqual({ pricing: DECLARED_PRICING, origin: 'model' })
  })

  it('falls back to the type default when the gateway table has no entry', () => {
    const result = priceSessionModel('kimi-k3', ctx({ typePricing: TYPE_PRICING }))
    expect(result).toEqual({ pricing: TYPE_PRICING, origin: 'type' })
  })

  it('falls back to the built-in catalog for a model the gateway table lacks', () => {
    const result = priceSessionModel('claude-sonnet-5', ctx({ gatewayRates: {} }))
    expect(result.origin).toBe('catalog')
    expect(result.pricing?.input).toBe(3)
  })

  it('returns {} when nothing matches', () => {
    expect(priceSessionModel('made-up-model', ctx({ gatewayRates: {} }))).toEqual({})
  })
})
