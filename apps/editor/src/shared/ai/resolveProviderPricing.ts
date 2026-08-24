/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Source-aware rate resolution: the rate for a model comes only from the provider's
 *  declared `pricingSource`. No declared source means "unknown" — never a fallback
 *  to another provider's table or a cross-vendor catalog lookup.
 *
 *  The `catalog` source must name its vendor in `options.vendor`. It deliberately
 *  does NOT fall back to the model's own vendor: which official price list applies
 *  to a channel is a property of the channel, not of the model. Deriving it from
 *  the model would also make the two call sites disagree — the model picker knows
 *  a model's vendor, the session-cost path only knows a bare wire name.
 *
 *  For the same reason the lookup key is the wire name, not the knowledge-base
 *  `ref`. A channel that renames an official model and declares a catalog source
 *  therefore resolves nothing — that is the honest answer here, because the
 *  session-cost path never sees a `ref` and would otherwise show "—" while the
 *  picker showed a rate. Such a channel should declare its own rate source.
 *
 *  The wire name may carry a trailing context/effort hint (`deepseek-v4-pro[1m]`,
 *  the spelling the agent reports usage under). Lookup tries the exact name first
 *  and only then the name with that hint stripped: a table pricing the 1M lane
 *  separately keeps winning on its own key, and one keyed by the bare name still
 *  applies. Nothing else is normalized — gateway keys are copied verbatim from
 *  remote JSON (lower-casing would miss a capitalized key) and catalog tables key
 *  off date snapshots, which are part of the id there.
 *--------------------------------------------------------------------------------------------*/

import type {
  AiModelPricing,
  AiPricingOrigin,
  AiRateTable,
  AiRemoteSourceSpec,
} from '@universe-editor/platform'
import { stripTrailingBracketSuffix } from './catalog/index.js'
import { OFFICIAL_CATALOGS, readCatalogVendor } from './catalog/modelKnowledge.js'

function lookupRate(table: AiRateTable | undefined, wireName: string): AiModelPricing | undefined {
  if (table === undefined) return undefined
  return table[wireName] ?? table[stripTrailingBracketSuffix(wireName)]
}

export function resolveModelPricing(input: {
  readonly bareModel: string
  readonly pricingSource?: AiRemoteSourceSpec
  readonly gatewayRates?: AiRateTable
}): { pricing?: AiModelPricing; origin?: AiPricingOrigin } {
  const source = input.pricingSource
  if (source === undefined) return {}

  if (source.id === 'catalog') {
    const vendor = readCatalogVendor(source.options)
    const table = vendor === undefined ? undefined : OFFICIAL_CATALOGS[vendor]
    const pricing = lookupRate(table, input.bareModel)
    return pricing === undefined ? {} : { pricing, origin: 'catalog' }
  }

  const pricing = lookupRate(input.gatewayRates, input.bareModel)
  return pricing === undefined ? {} : { pricing, origin: 'gateway' }
}
