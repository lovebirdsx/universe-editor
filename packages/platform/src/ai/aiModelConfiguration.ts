/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Shape of aiSettings.json and the model-id grammar. A callable model is
 *  identified by `providerId/protocol/channelModel`: the gateway that serves it,
 *  the wire protocol it is reached through, and the name that endpoint expects.
 *  Provider entries themselves live in aiProviderEntry.ts.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../nls/nls.js'
import type { AiModelKnowledge, AiProviderEntry } from './aiProviderEntry.js'
import {
  isAiWireProtocol,
  type AiModelConfiguration,
  type AiModelConfigProperty,
  type AiModelConfigSchema,
  type AiWireProtocol,
} from './aiModelTypes.js'

/** Which active-model slot a selection occupies. */
export type AiActiveModelKind = 'chat' | 'inlineCompletion' | 'commit' | 'sessionTitle'

/** The user's active model selections, persisted in aiSettings.json. */
export interface AiActiveModels {
  readonly chat?: string
  readonly inlineCompletion?: string
  readonly commit?: string
  readonly sessionTitle?: string
}

/** Top-level shape of aiSettings.json. */
export interface AiSettingsFile {
  /** Model knowledge base, keyed by logical model id. Merged over the built-in one. */
  readonly models?: Readonly<Record<string, AiModelKnowledge>>
  readonly providers: readonly AiProviderEntry[]
  /** Per-model user configuration, keyed by full model id. */
  readonly modelSettings?: Readonly<Record<string, AiModelConfiguration>>
  readonly activeModels?: AiActiveModels
  /** Per-agent editor state (authentication choice, model overrides). */
  readonly agentSettings?: Readonly<Record<string, unknown>>
}

/** A candidate provider entry to probe for validity (never persisted as-is). */
export interface AiProviderVerifyInput {
  readonly id: string
  readonly protocol: AiWireProtocol
  readonly baseUrl?: string
  /** Probed in-memory only. */
  readonly apiKey?: string
}

/** Outcome of probing a candidate entry against its endpoint. */
export interface AiProviderVerifyResult {
  readonly ok: boolean
  readonly modelCount: number
  readonly error?: string
}

/** A model id parsed back into its three segments. */
export interface AiModelRef {
  readonly providerId: string
  readonly protocol: AiWireProtocol
  /** Keeps any remaining '/' — gateways do serve names like 'anthropic/claude-opus'. */
  readonly channelModel: string
}

export function composeModelId(
  providerId: string,
  protocol: AiWireProtocol,
  channelModel: string,
): string {
  return `${providerId}/${protocol}/${channelModel}`
}

/**
 * Parse a model id. The middle segment must be a known protocol, so a stale
 * two-layer id (`type/instance/model`) fails to parse instead of silently
 * resolving to a provider that does not exist.
 */
export function parseModelRef(modelId: string): AiModelRef | undefined {
  const first = modelId.indexOf('/')
  if (first <= 0) return undefined
  const second = modelId.indexOf('/', first + 1)
  if (second <= first + 1) return undefined
  const protocol = modelId.slice(first + 1, second)
  if (!isAiWireProtocol(protocol)) return undefined
  const channelModel = modelId.slice(second + 1)
  if (channelModel === '') return undefined
  return { providerId: modelId.slice(0, first), protocol, channelModel }
}

/** Strip the `providerId/protocol/` prefix back to the wire name the endpoint expects. */
export function bareModelName(
  modelId: string,
  providerId: string,
  protocol: AiWireProtocol,
): string {
  const prefix = `${providerId}/${protocol}/`
  return modelId.startsWith(prefix) ? modelId.slice(prefix.length) : modelId
}

export function buildModelConfigSchema(
  knowledge: AiModelKnowledge,
  base?: AiModelConfigSchema,
): AiModelConfigSchema | undefined {
  const merged: Record<string, AiModelConfigProperty> = { ...base }
  if (knowledge.supportsReasoningEffort?.length) {
    merged.reasoningEffort = {
      type: 'enum',
      enum: [...knowledge.supportsReasoningEffort],
      description: localize('ai.modelSettings.reasoningEffort', 'Reasoning effort level.'),
      group: 'navigation',
    }
  }
  if (knowledge.parameters) {
    for (const [key, prop] of Object.entries(knowledge.parameters)) merged[key] = prop
  }
  return Object.keys(merged).length > 0 ? merged : undefined
}
