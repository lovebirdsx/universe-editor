/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Pure derivation of the per-CLI credential shapes from a provider *instance*.
 *  The Claude / Codex credential libraries now reference a provider via
 *  `providerRef` (`type/name`) instead of inlining a base URL + key; these
 *  functions resolve that reference and flatten the instance + type into what
 *  each CLI actually consumes. No DI, no IO — shared by renderer and main.
 *--------------------------------------------------------------------------------------------*/

import {
  providerKey,
  resolveModelBaseUrl,
  type AiProviderInstance,
  type AiProviderType,
  type AiWireProtocol,
} from '@universe-editor/platform'

/** Resolve a `type/name` providerRef to its instance + type; either missing → undefined. */
export function resolveProviderRef(
  ref: string,
  providers: readonly AiProviderInstance[],
  types: Readonly<Record<string, AiProviderType>>,
): { instance: AiProviderInstance; type: AiProviderType } | undefined {
  const instance = providers.find((p) => providerKey(p) === ref)
  if (instance === undefined) return undefined
  const type = types[instance.type]
  if (type === undefined) return undefined
  return { instance, type }
}

/**
 * Whether an instance can serve `protocol`: its type's default protocol, or a
 * model-level `protocol` override on the type's / instance's `models[]` (the
 * two-layer model allows a mixed-protocol gateway).
 */
export function providerSupportsProtocol(
  instance: AiProviderInstance,
  type: AiProviderType | undefined,
  protocol: AiWireProtocol,
): boolean {
  if (type === undefined) return false
  if (type.protocol === protocol) return true
  for (const model of type.models ?? []) {
    if (model.protocol === protocol) return true
  }
  for (const model of instance.models ?? []) {
    if (model.protocol === protocol) return true
  }
  return false
}

/** Claude Code's env injection (`ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_BASE_URL`). */
export function deriveClaudeEnv(
  instance: AiProviderInstance,
  type: AiProviderType,
): { authToken: string; baseUrl: string } | undefined {
  const key = instance.apiKey
  if (key === undefined || key.trim() === '') return undefined
  const baseUrl = resolveModelBaseUrl(undefined, instance.baseUrl, type.defaultBaseUrl)
  if (baseUrl === undefined || baseUrl.trim() === '') return undefined
  return { authToken: key, baseUrl }
}

/** Codex's gateway intent (kind omitted — the caller adds it). */
export function deriveCodexProvider(
  instance: AiProviderInstance,
  type: AiProviderType,
): { baseUrl: string; apiKey: string; providerName: string } | undefined {
  const key = instance.apiKey
  if (key === undefined || key.trim() === '') return undefined
  const baseUrl = resolveModelBaseUrl(undefined, instance.baseUrl, type.defaultBaseUrl)
  if (baseUrl === undefined || baseUrl.trim() === '') return undefined
  // `providerName` is the display `name` of the `[model_providers.codex-gateway]`
  // block, not its key — keep it human-readable.
  return { baseUrl, apiKey: key, providerName: (instance.label ?? instance.name).trim() }
}
