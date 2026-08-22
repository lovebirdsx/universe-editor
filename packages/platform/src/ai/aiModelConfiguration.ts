/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Provider-type / provider-instance data model. A type owns the protocol,
 *  model catalog, rates, and remote sources; an instance is one gateway entry
 *  (connection + credential). Models are identified by `type/instance/model`.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../nls/nls.js'
import type { AiRemoteSourceSpec } from './aiRemoteSources.js'
import type { AiModelPricing } from './aiModelPricing.js'
import type {
  AiModelCapabilities,
  AiModelConfiguration,
  AiModelConfigProperty,
  AiModelConfigSchema,
  AiWireProtocol,
} from './aiModelTypes.js'

/** A provider *type*: protocol + model catalog + rates + remote sources. Built-in or user-defined. */
export interface AiProviderType {
  readonly label?: string
  readonly protocol: AiWireProtocol
  readonly defaultBaseUrl?: string
  readonly requiresApiKey?: boolean
  /** Hand-declared model catalog shared by every instance of this type. */
  readonly models?: readonly AiCustomModelConfig[]
  /** Type-level default rate, used when a model declares none. */
  readonly pricing?: AiModelPricing
  readonly pricingSource?: AiRemoteSourceSpec
  readonly usageSource?: AiRemoteSourceSpec
}

/** A provider *instance* (one gateway entry): connection + credential. Persisted in aiSettings.json. */
export interface AiProviderInstance {
  /** Instance name, unique within a type, e.g. 'default' / 'gbl'. Must not contain '/'. */
  readonly name: string
  /** Provider type id this instance binds to. */
  readonly type: string
  readonly label?: string
  readonly baseUrl?: string
  /** Plaintext, by explicit user decision (cross-machine sync). Never logged. */
  readonly apiKey?: string
  /** Instance-level account usage source, overriding the type's. */
  readonly usageSource?: AiRemoteSourceSpec
  /** Extra models only this instance offers; merged after the type's catalog (instance wins on same id). */
  readonly models?: readonly AiCustomModelConfig[]
  /** Per-model user configuration, keyed by full model id (`type/instance/model`). */
  readonly settings?: Readonly<Record<string, AiModelConfiguration>>
}

/** A hand-declared model inside a type's or instance's `models[]`. */
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
  /** Overrides the type's protocol for this single model. */
  readonly protocol?: AiWireProtocol
  /** Overrides the instance's / type's baseUrl for this single model. */
  readonly baseUrl?: string
  /** Model-level rate; wins over the type's default. */
  readonly pricing?: AiModelPricing
}

/** Runtime form handed to a provider: flattened config with the apiKey inline. */
export interface AiResolvedProvider {
  readonly type: string
  readonly name: string
  readonly protocol: AiWireProtocol
  readonly label?: string
  readonly baseUrl?: string
  readonly apiKey?: string
  readonly requiresApiKey?: boolean
  readonly declaredModels?: readonly AiCustomModelConfig[]
  readonly typePricing?: AiModelPricing
  readonly pricingSource?: AiRemoteSourceSpec
  readonly usageSource?: AiRemoteSourceSpec
}

/** Which active-model slot a selection occupies. */
export type AiActiveModelKind = 'chat' | 'inlineCompletion' | 'commit' | 'sessionTitle'

/** The user's active model selections, persisted in aiSettings.json. */
export interface AiActiveModels {
  readonly chat?: string
  readonly inlineCompletion?: string
  readonly commit?: string
  readonly sessionTitle?: string
}

/** Top-level shape of aiSettings.json: provider types / instances, active selections, and agent UI state. */
export interface AiSettingsFile {
  /** User-defined / overridden provider types, keyed by type id. */
  readonly providerTypes?: Readonly<Record<string, AiProviderType>>
  readonly providers: readonly AiProviderInstance[]
  readonly activeModels?: AiActiveModels
  /** Per-agent editor state, including credential libraries and unfinished authentication forms. */
  readonly agentSettings?: Readonly<Record<string, unknown>>
}

/** A selectable provider type in the "add provider" flow. */
export interface AiProviderTypeDescriptor {
  readonly id: string
  readonly label: string
  readonly protocol: AiWireProtocol
  readonly defaultBaseUrl?: string
  readonly requiresApiKey: boolean
  /** False for types the user defined in aiSettings.json. */
  readonly builtin: boolean
}

/** A candidate provider instance to probe for validity (never persisted as-is). */
export interface AiProviderVerifyInput {
  readonly type: string
  readonly name: string
  readonly protocol: AiWireProtocol
  readonly baseUrl?: string
  /** Probed in-memory only. */
  readonly apiKey?: string
}

/** Outcome of probing a candidate instance against its endpoint. */
export interface AiProviderVerifyResult {
  readonly ok: boolean
  readonly modelCount: number
  readonly error?: string
}

/** Stable cache / lookup key for an instance: `type/name`. */
export function providerKey(p: { readonly type: string; readonly name: string }): string {
  return `${p.type}/${p.name}`
}

/** Compose the three-segment model id. */
export function composeModelId(typeId: string, instanceName: string, model: string): string {
  return `${typeId}/${instanceName}/${model}`
}

/** Strip the `type/instance/` prefix back to the bare model name the API expects. */
export function bareModelName(modelId: string, typeId: string, instanceName: string): string {
  const prefix = `${typeId}/${instanceName}/`
  return modelId.startsWith(prefix) ? modelId.slice(prefix.length) : modelId
}

/** Provider-type segment of a model id (first '/'-delimited segment). */
export function providerTypeFromModelId(modelId: string): string | undefined {
  const slash = modelId.indexOf('/')
  return slash > 0 ? modelId.slice(0, slash) : undefined
}

/** Parse a model id into its three segments; the model segment keeps any remaining '/'. */
export function parseModelRef(
  modelId: string,
): { type: string; instance: string; model: string } | undefined {
  const first = modelId.indexOf('/')
  if (first <= 0) return undefined
  const second = modelId.indexOf('/', first + 1)
  if (second <= first) return undefined
  return {
    type: modelId.slice(0, first),
    instance: modelId.slice(first + 1, second),
    model: modelId.slice(second + 1),
  }
}

/** Resolve a model's wire protocol, falling back to the type's protocol. */
export function resolveModelProtocol(
  model: AiCustomModelConfig | undefined,
  typeProtocol: AiWireProtocol,
): AiWireProtocol {
  return model?.protocol ?? typeProtocol
}

/** Resolve a model's baseUrl: model override → instance baseUrl → type default. */
export function resolveModelBaseUrl(
  model: AiCustomModelConfig | undefined,
  instanceBaseUrl: string | undefined,
  typeDefaultBaseUrl: string | undefined,
): string | undefined {
  return model?.baseUrl ?? instanceBaseUrl ?? typeDefaultBaseUrl
}

/** Flatten (instances × types) into the runtime form providers consume. */
export function resolveProviderInstances(
  instances: readonly AiProviderInstance[],
  types: Readonly<Record<string, AiProviderType>>,
): readonly AiResolvedProvider[] {
  const resolved: AiResolvedProvider[] = []
  for (const instance of instances) {
    const type = types[instance.type]
    if (!type) continue
    resolved.push(resolveProviderInstance(instance, type))
  }
  return resolved
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
      description: localize('ai.modelSettings.reasoningEffort', 'Reasoning effort level.'),
      group: 'navigation',
    }
  }
  if (config.parameters) {
    for (const [key, prop] of Object.entries(config.parameters)) merged[key] = prop
  }
  return Object.keys(merged).length > 0 ? merged : undefined
}

function resolveProviderInstance(
  instance: AiProviderInstance,
  type: AiProviderType,
): AiResolvedProvider {
  const label = instance.label ?? type.label
  const baseUrl = instance.baseUrl ?? type.defaultBaseUrl
  const usageSource = instance.usageSource ?? type.usageSource
  const declaredModels = mergeModels(type.models, instance.models)
  return {
    type: instance.type,
    name: instance.name,
    protocol: type.protocol,
    ...(label !== undefined ? { label } : {}),
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(instance.apiKey !== undefined ? { apiKey: instance.apiKey } : {}),
    ...(type.requiresApiKey !== undefined ? { requiresApiKey: type.requiresApiKey } : {}),
    ...(declaredModels !== undefined ? { declaredModels } : {}),
    ...(type.pricing !== undefined ? { typePricing: type.pricing } : {}),
    ...(type.pricingSource !== undefined ? { pricingSource: type.pricingSource } : {}),
    ...(usageSource !== undefined ? { usageSource } : {}),
  }
}

function mergeModels(
  typeModels: readonly AiCustomModelConfig[] | undefined,
  instanceModels: readonly AiCustomModelConfig[] | undefined,
): readonly AiCustomModelConfig[] | undefined {
  if (!typeModels?.length && !instanceModels?.length) return undefined
  const byId = new Map<string, AiCustomModelConfig>()
  for (const m of typeModels ?? []) byId.set(m.id, m)
  for (const m of instanceModels ?? []) byId.set(m.id, m)
  return [...byId.values()]
}
