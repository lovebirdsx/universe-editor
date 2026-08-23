/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Pure derivation of the per-CLI credential shapes from a single-layer resolved
 *  provider. No DI, no IO — shared by renderer and main.
 *--------------------------------------------------------------------------------------------*/

import type { AiResolvedProvider } from '@universe-editor/platform'
import { isOfficialEndpoint } from './officialEndpoints.js'

export type ClaudeAuthEnv =
  | { readonly kind: 'apiKey'; readonly apiKey: string }
  | { readonly kind: 'gateway'; readonly authToken: string; readonly baseUrl: string }

/** Official endpoint → ANTHROPIC_API_KEY; gateway → ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL. */
export function deriveClaudeAuth(
  provider: AiResolvedProvider | undefined,
): ClaudeAuthEnv | undefined {
  if (provider === undefined) return undefined
  const key = provider.apiKey
  if (key === undefined || key.trim() === '') return undefined
  if (isOfficialEndpoint('anthropic-messages', provider.baseUrl)) {
    return { kind: 'apiKey', apiKey: key }
  }
  const baseUrl = provider.baseUrl
  if (baseUrl === undefined || baseUrl.trim() === '') return undefined
  return { kind: 'gateway', authToken: key, baseUrl }
}

/** Codex's gateway intent, derived from the single-layer resolved provider. */
export function deriveCodexGateway(
  provider: AiResolvedProvider | undefined,
): { baseUrl: string; apiKey: string; providerName: string } | undefined {
  if (provider === undefined) return undefined
  const key = provider.apiKey
  if (key === undefined || key.trim() === '') return undefined
  const baseUrl = provider.baseUrl
  if (baseUrl === undefined || baseUrl.trim() === '') return undefined
  return { baseUrl, apiKey: key, providerName: (provider.label ?? provider.id).trim() }
}

export function findProviderById(
  providers: readonly AiResolvedProvider[],
  id: string | undefined,
): AiResolvedProvider | undefined {
  if (id === undefined) return undefined
  return providers.find((p) => p.id === id)
}
