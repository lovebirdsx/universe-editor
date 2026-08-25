/*---------------------------------------------------------------------------------------------
 *  Content fingerprints the registry uses to decide whether a cached model
 *  enumeration can survive a settings reload. A fingerprint must change exactly
 *  when the models a provider serves — or the metadata they render as — could
 *  change; pure presentation fields (pricingSource / usageSource) stay out.
 *  Internal to the ai directory; not part of the public barrel.
 *--------------------------------------------------------------------------------------------*/

import type { AiModelKnowledge, AiResolvedProvider } from './aiProviderEntry.js'

/**
 * Fingerprint of every field that feeds `listModels` or the metadata a served
 * model renders as: id, endpoint, credential, and each protocol's declared
 * model refs (with their resolved knowledge already inlined by
 * resolveProviderEntries).
 */
export function computeProviderModelFingerprint(provider: AiResolvedProvider): string {
  return stableStringify({
    id: provider.id,
    ...(provider.baseUrl !== undefined ? { baseUrl: provider.baseUrl } : {}),
    ...(provider.apiKey !== undefined ? { apiKey: provider.apiKey } : {}),
    defaultProtocol: provider.defaultProtocol,
    protocols: provider.protocols,
  })
}

/**
 * Fingerprint of the whole knowledge base. Discovered models merge this in at
 * enumeration time, so a content change must invalidate those caches.
 */
export function computeKnowledgeFingerprint(
  knowledge: Readonly<Record<string, AiModelKnowledge>>,
): string {
  return stableStringify(knowledge)
}

/** JSON.stringify with object keys sorted, so equal content yields equal text. */
function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value !== null && typeof value === 'object') {
    const sorted: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key]
      if (child !== undefined) sorted[key] = sortValue(child)
    }
    return sorted
  }
  return value
}
