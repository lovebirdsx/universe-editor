/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Built-in model knowledge (intrinsic metadata, no pricing) and the official
 *  rate catalogs, split per vendor so a `pricingSource: { id: 'catalog' }` can
 *  address exactly one vendor's list price without any cross-vendor fallback.
 *--------------------------------------------------------------------------------------------*/

import type { AiModelKnowledge, AiRateTable } from '@universe-editor/platform'
import { ANTHROPIC_CATALOG, ANTHROPIC_MODEL_KNOWLEDGE } from './anthropic.js'
import { DEEPSEEK_CATALOG } from './deepseek.js'
import { MOONSHOT_CATALOG } from './moonshot.js'
import { OPENAI_CATALOG, OPENAI_MODEL_KNOWLEDGE } from './openai.js'

export const BUILTIN_MODEL_KNOWLEDGE: Readonly<Record<string, AiModelKnowledge>> = {
  ...ANTHROPIC_MODEL_KNOWLEDGE,
  ...OPENAI_MODEL_KNOWLEDGE,
}

/** bare model id → rate, keyed by real vendor. */
export const OFFICIAL_CATALOGS: Readonly<Record<string, AiRateTable>> = {
  anthropic: ANTHROPIC_CATALOG,
  openai: OPENAI_CATALOG,
  deepseek: DEEPSEEK_CATALOG,
  moonshot: MOONSHOT_CATALOG,
}

/** Read the `vendor` option of a catalog pricing source; non-string values are treated as absent. */
export function readCatalogVendor(
  options: Readonly<Record<string, unknown>> | undefined,
): string | undefined {
  const vendor = options?.['vendor']
  return typeof vendor === 'string' ? vendor : undefined
}
