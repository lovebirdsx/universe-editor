/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import type { AiModelPricing } from '@universe-editor/platform'
import { resolveModelPricing } from '../resolveModelPricing.js'

const MODEL_PRICING: AiModelPricing = { input: 1, output: 2 }
const GATEWAY_PRICING: AiModelPricing = { input: 3, output: 4 }
const TYPE_PRICING: AiModelPricing = { input: 5, output: 6 }

describe('resolveModelPricing', () => {
  it('prefers the model-level rate over the gateway table', () => {
    const result = resolveModelPricing({
      modelId: 'anthropic/default/claude-sonnet-5',
      model: { id: 'claude-sonnet-5', pricing: MODEL_PRICING },
      gatewayRates: { 'claude-sonnet-5': GATEWAY_PRICING },
      typePricing: TYPE_PRICING,
    })
    expect(result).toEqual({ pricing: MODEL_PRICING, origin: 'model' })
  })

  it('prefers the gateway table over the type default', () => {
    const result = resolveModelPricing({
      modelId: 'openai/default/gpt-5.4',
      gatewayRates: { 'gpt-5.4': GATEWAY_PRICING },
      typePricing: TYPE_PRICING,
    })
    expect(result).toEqual({ pricing: GATEWAY_PRICING, origin: 'gateway' })
  })

  it('prefers the type default over the built-in catalog', () => {
    const result = resolveModelPricing({
      modelId: 'anthropic/default/claude-sonnet-5',
      typePricing: TYPE_PRICING,
    })
    expect(result).toEqual({ pricing: TYPE_PRICING, origin: 'type' })
  })

  it('falls back to the built-in catalog for a built-in model', () => {
    const result = resolveModelPricing({
      modelId: 'anthropic/default/claude-sonnet-5',
    })
    expect(result.origin).toBe('catalog')
    expect(result.pricing?.input).toBe(3)
  })

  it('returns {} when nothing matches', () => {
    expect(resolveModelPricing({ modelId: 'anthropic/default/claude-made-up-9' })).toEqual({})
  })

  it('normalizes the bare id before the gateway-table fallback lookup', () => {
    const result = resolveModelPricing({
      modelId: 'openai/default/gpt-5.4-codex[high]',
      gatewayRates: { 'gpt-5.4-codex': GATEWAY_PRICING },
    })
    expect(result).toEqual({ pricing: GATEWAY_PRICING, origin: 'gateway' })
  })
})
