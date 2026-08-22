/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Five-level rate resolution for a model: model → gateway table → type default
 *  → built-in catalog → undefined. Deliberately no guessing fallback — "rate
 *  unknown" is a state the UI renders, not a number we invent.
 *--------------------------------------------------------------------------------------------*/

import {
  parseModelRef,
  type AiCustomModelConfig,
  type AiModelPricing,
  type AiPricingOrigin,
  type AiRateTable,
} from '@universe-editor/platform'
import { lookupCatalogPricing, normalizeCatalogModelId } from './catalog/index.js'

export interface ResolveModelPricingInput {
  /** Full three-segment model id (`type/instance/model`). */
  readonly modelId: string
  /** The hand-declared model config, if the model is declared. Level 1. */
  readonly model?: AiCustomModelConfig | undefined
  /** Rate table fetched from the gateway for this instance, keyed by bare model id. Level 2. */
  readonly gatewayRates?: AiRateTable | undefined
  /** The provider type's default rate. Level 3. */
  readonly typePricing?: AiModelPricing | undefined
}

export interface ResolvedModelPricing {
  readonly pricing?: AiModelPricing
  readonly origin?: AiPricingOrigin
}

export function resolveModelPricing(input: ResolveModelPricingInput): ResolvedModelPricing {
  if (input.model?.pricing) {
    return { pricing: input.model.pricing, origin: 'model' }
  }

  const bare = parseModelRef(input.modelId)?.model ?? input.modelId

  if (input.gatewayRates) {
    const raw = input.gatewayRates[bare]
    if (raw) return { pricing: raw, origin: 'gateway' }
    const normalized = input.gatewayRates[normalizeCatalogModelId(bare)]
    if (normalized) return { pricing: normalized, origin: 'gateway' }
  }

  if (input.typePricing) {
    return { pricing: input.typePricing, origin: 'type' }
  }

  const catalog = lookupCatalogPricing(bare)
  if (catalog) {
    return { pricing: catalog, origin: 'catalog' }
  }

  return {}
}
