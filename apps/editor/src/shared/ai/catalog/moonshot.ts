/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Built-in Moonshot (Kimi) model catalog. Rates are the published CNY list
 *  prices, preserved as CNY rather than pre-converted to USD. Cache Write is
 *  "—" in the price sheet, so cacheWrite is omitted (billed as base input).
 *--------------------------------------------------------------------------------------------*/

import type { AiModelPricing, AiRateTable } from '@universe-editor/platform'

const K2_PRICING: AiModelPricing = { currency: 'CNY', input: 6.5, output: 27, cacheRead: 1.3 }
const K3_PRICING: AiModelPricing = { currency: 'CNY', input: 20, output: 100, cacheRead: 2 }

export const MOONSHOT_CATALOG: AiRateTable = {
  'kimi-k2.6': K2_PRICING,
  'kimi-k2.7-code': K2_PRICING,
  'kimi-k2-6': K2_PRICING,
  'kimi-k3': K3_PRICING,
  'kimi-k3-mini': K3_PRICING,
}
