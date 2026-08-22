/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Built-in AI provider types and an exact-match rate lookup across every
 *  built-in catalog. Unknown models resolve to undefined — never guessed.
 *--------------------------------------------------------------------------------------------*/

import type { AiModelPricing, AiProviderType, AiRateTable } from '@universe-editor/platform'
import { ANTHROPIC_CATALOG, ANTHROPIC_MODELS } from './anthropic.js'
import { DEEPSEEK_CATALOG } from './deepseek.js'
import { MOONSHOT_CATALOG } from './moonshot.js'
import { OPENAI_CATALOG, OPENAI_MODELS } from './openai.js'

/** Built-in provider types, merged under any user-defined types from aiSettings.json. */
export const BUILTIN_PROVIDER_TYPES: Readonly<Record<string, AiProviderType>> = {
  anthropic: {
    label: 'Anthropic (Messages API)',
    protocol: 'anthropic-messages',
    defaultBaseUrl: 'https://api.anthropic.com',
    requiresApiKey: true,
    models: ANTHROPIC_MODELS,
  },
  openai: {
    label: 'OpenAI (compatible)',
    protocol: 'openai-chat',
    defaultBaseUrl: 'https://api.openai.com/v1',
    requiresApiKey: true,
    models: OPENAI_MODELS,
  },
  ollama: {
    label: 'Ollama',
    protocol: 'ollama',
    defaultBaseUrl: 'http://127.0.0.1:11434',
    requiresApiKey: false,
  },
}

/**
 * Strip lossless, non-identity suffixes from a model id: casing, whitespace,
 * context/effort hints (`[1m]` / `[high]`) and trailing date snapshots. The
 * remaining id is still the same model — this is not family guessing.
 */
export function normalizeCatalogModelId(id: string): string {
  return id
    .trim()
    .toLowerCase()
    .replace(/\[[^\]]*\]$/, '')
    .replace(/-\d{4}-\d{2}-\d{2}$/, '')
    .replace(/-\d{8}$/, '')
}

// Keys are normalized too (not just lowercased) so date-suffixed catalog ids
// (e.g. `claude-opus-4-20250514`) stay reachable through the same lookup path.
const CATALOG_LOOKUP: ReadonlyMap<string, AiModelPricing> = (() => {
  const table = new Map<string, AiModelPricing>()
  const catalogs: readonly AiRateTable[] = [
    ANTHROPIC_CATALOG,
    OPENAI_CATALOG,
    MOONSHOT_CATALOG,
    DEEPSEEK_CATALOG,
  ]
  for (const catalog of catalogs) {
    for (const [id, pricing] of Object.entries(catalog)) {
      table.set(normalizeCatalogModelId(id), pricing)
    }
  }
  return table
})()

/** Exact-match rate lookup across every built-in catalog. Returns undefined for unknown models — never guesses. */
export function lookupCatalogPricing(bareModelId: string): AiModelPricing | undefined {
  return CATALOG_LOOKUP.get(normalizeCatalogModelId(bareModelId))
}

const ANTHROPIC_IDS: ReadonlySet<string> = new Set(
  Object.keys(ANTHROPIC_CATALOG).map(normalizeCatalogModelId),
)

/**
 * Whether a bare model id is one of Anthropic's own models. Exact catalog
 * membership, not a name-prefix guess — callers use it to decide whether the
 * Claude CLI's self-reported cost can be trusted for that row.
 */
export function isAnthropicCatalogModel(bareModelId: string): boolean {
  return ANTHROPIC_IDS.has(normalizeCatalogModelId(bareModelId))
}
