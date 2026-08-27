/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Built-in Acme model catalog. Rates are the published CNY list prices,
 *  preserved as CNY. Cache Write is "—" in the price sheet, so cacheWrite is
 *  omitted (billed as base input).
 *--------------------------------------------------------------------------------------------*/

import type { AiRateTable } from '@universe-editor/platform'

export const DEEPSEEK_CATALOG: AiRateTable = {
  'acme-chat-flash': { currency: 'CNY', input: 1, output: 2, cacheRead: 0.2 },
  'acme-chat-pro': { currency: 'CNY', input: 12, output: 24, cacheRead: 1 },
}
