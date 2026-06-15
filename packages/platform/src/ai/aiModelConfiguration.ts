/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Provider-group data model, distilled from VSCode's chatLanguageModels.json
 *  shape. A vendor may have several named groups; each group is the unit of
 *  configuration (baseUrl / hand-declared models / per-model settings) and the
 *  unit of secret storage. Models are identified by `vendor/group/model`.
 *--------------------------------------------------------------------------------------------*/

import type {
  AiModelCapabilities,
  AiModelConfiguration,
  AiModelConfigProperty,
  AiModelConfigSchema,
} from './aiModelTypes.js'

/** Persisted form of one provider group, as stored in aiModels.json. */
export interface AiProviderGroup {
  /** Group name, unique within a vendor, e.g. 'default'. Must not contain '/'. */
  readonly name: string
  /** Vendor this group binds to, e.g. 'openai' or 'ollama'. */
  readonly vendor: string
  /** Endpoint override; falls back to the provider's default when absent. */
  readonly baseUrl?: string
  /** Hand-declared models, merged with whatever the endpoint enumerates. */
  readonly models?: readonly AiCustomModelConfig[]
  /** Per-model user configuration, keyed by full model id (`vendor/group/model`). */
  readonly settings?: Readonly<Record<string, AiModelConfiguration>>
}

/** A hand-declared model inside a group's `models[]`. */
export interface AiCustomModelConfig {
  /** Bare model name the endpoint expects, e.g. 'qwen3-coder'. */
  readonly id: string
  readonly name?: string
  readonly family?: string
  readonly maxInputTokens?: number
  readonly maxOutputTokens?: number
  readonly capabilities?: AiModelCapabilities
  /** Reasoning-effort levels this model accepts; drives a `reasoningEffort` schema. */
  readonly supportsReasoningEffort?: readonly string[]
  /**
   * Extra tunable parameters for this model, surfaced in the Configure form.
   * Each key is sent verbatim as a request-body field (no camelCase→snake_case
   * mapping), so declare it under the name the endpoint expects (e.g. 'top_k').
   */
  readonly parameters?: AiModelConfigSchema
}

/** Runtime form handed to a provider: config plus lazy secret access. */
export interface AiResolvedGroup {
  readonly vendor: string
  readonly name: string
  readonly baseUrl?: string
  readonly declaredModels?: readonly AiCustomModelConfig[]
  getApiKey(): Promise<string | undefined>
}

/** Stable cache / lookup key for a group: `vendor/name`. */
export function groupKey(group: { readonly vendor: string; readonly name: string }): string {
  return `${group.vendor}/${group.name}`
}

/** Compose the three-segment model id. */
export function composeModelId(vendor: string, groupName: string, model: string): string {
  return `${vendor}/${groupName}/${model}`
}

/** Strip the `vendor/group/` prefix back to the bare model name the API expects. */
export function bareModelName(modelId: string, vendor: string, groupName: string): string {
  const prefix = `${vendor}/${groupName}/`
  return modelId.startsWith(prefix) ? modelId.slice(prefix.length) : modelId
}

/** Vendor segment of a model id (first '/'-delimited segment). */
export function vendorFromModelId(modelId: string): string | undefined {
  const slash = modelId.indexOf('/')
  return slash > 0 ? modelId.slice(0, slash) : undefined
}

export function buildModelConfigSchema(
  config: AiCustomModelConfig,
  base?: AiModelConfigSchema,
): AiModelConfigSchema | undefined {
  const merged: Record<string, AiModelConfigProperty> = { ...base }
  if (config.supportsReasoningEffort?.length) {
    merged.reasoningEffort = {
      type: 'enum',
      enum: [...config.supportsReasoningEffort],
      description: 'Reasoning effort level.',
      group: 'navigation',
    }
  }
  if (config.parameters) {
    for (const [key, prop] of Object.entries(config.parameters)) merged[key] = prop
  }
  return Object.keys(merged).length > 0 ? merged : undefined
}
