/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Single-layer provider data model. A provider entry is one gateway endpoint
 *  (connection + credential); its `protocolMap` declares which wire protocols it
 *  speaks and which models each protocol exposes. Model metadata lives in a
 *  separate knowledge base, keyed by logical model id — knowledge, not identity.
 *  A callable model is identified by `providerId/protocol/channelModel`.
 *--------------------------------------------------------------------------------------------*/

import type { AiRemoteSourceSpec } from './aiRemoteSources.js'
import type { AiModelCapabilities, AiModelConfigSchema, AiWireProtocol } from './aiModelTypes.js'
import { lookupModelKnowledge } from './aiModelLane.js'

/**
 * Intrinsic properties of a model — the things that do not change when you reach
 * it through a different gateway. Deliberately excludes pricing: a rate is always
 * a function of (channel, model), never of the model alone.
 */
export interface AiModelKnowledge {
  readonly name?: string
  readonly family?: string
  /** Real vendor, e.g. 'anthropic' — distinct from the channel it is reached through. */
  readonly vendor?: string
  /** Protocol this model speaks on its own vendor's endpoint; anything else is a translation. */
  readonly nativeProtocol?: AiWireProtocol
  readonly maxInputTokens?: number
  readonly maxOutputTokens?: number
  readonly capabilities?: AiModelCapabilities
  readonly supportsReasoningEffort?: readonly string[]
  readonly parameters?: AiModelConfigSchema
}

/**
 * An entry in `protocolMap[protocol]` that needs more than a bare name: the
 * channel renamed the model, or the translation dropped a capability.
 */
export interface AiProtocolModelOverride extends AiModelKnowledge {
  /** Wire name this channel expects. Defaults to `ref`. */
  readonly id?: string
  /** Knowledge-base key. Defaults to `id`. */
  readonly ref?: string
}

/** A string is shorthand for "wire name equals knowledge key, no overrides". */
export type AiProtocolModelRef = string | AiProtocolModelOverride

/** Empty array means "enumerate from this provider's model endpoint". */
export type AiProtocolMap = Readonly<Partial<Record<AiWireProtocol, readonly AiProtocolModelRef[]>>>

/** One gateway endpoint. Persisted in aiSettings.json under `providers[]`. */
export interface AiProviderEntry {
  /** Unique id; also the first segment of every model id it serves. Must not contain '/'. */
  readonly id: string
  /** Inherit from another entry. For alternate access points of the same gateway. */
  readonly extends?: string
  readonly baseUrl?: string
  /** Plaintext, by explicit user decision (cross-machine sync). Never logged. */
  readonly apiKey?: string
  /** Protocol the editor uses when the caller does not pick one. */
  readonly defaultProtocol?: AiWireProtocol
  readonly protocolMap?: AiProtocolMap
  readonly pricingSource?: AiRemoteSourceSpec
  readonly usageSource?: AiRemoteSourceSpec
}

/** A model declared under one protocol of one provider, with its knowledge applied. */
export interface AiResolvedProtocolModel {
  /** Wire name sent to the endpoint. */
  readonly channelModel: string
  /** Knowledge-base key this model resolved against. */
  readonly ref: string
  readonly knowledge: AiModelKnowledge
}

export interface AiResolvedProtocol {
  readonly protocol: AiWireProtocol
  /** Empty when {@link discover} is true. */
  readonly models: readonly AiResolvedProtocolModel[]
  /** The entry declared `[]`: availability comes from the endpoint, not the file. */
  readonly discover: boolean
}

/** Runtime form handed to the registry and providers: extends flattened, apiKey inline. */
export interface AiResolvedProvider {
  readonly id: string
  readonly baseUrl?: string
  readonly apiKey?: string
  readonly defaultProtocol: AiWireProtocol
  readonly protocols: readonly AiResolvedProtocol[]
  readonly pricingSource?: AiRemoteSourceSpec
  readonly usageSource?: AiRemoteSourceSpec
}

/** Per-protocol view of a resolved provider, handed to that protocol's provider implementation. */
export interface AiProviderRuntime {
  readonly id: string
  readonly protocol: AiWireProtocol
  readonly baseUrl?: string
  readonly apiKey?: string
}

export function protocolRuntime(
  provider: AiResolvedProvider,
  protocol: AiWireProtocol,
): AiProviderRuntime {
  return {
    id: provider.id,
    protocol,
    ...(provider.baseUrl !== undefined ? { baseUrl: provider.baseUrl } : {}),
    ...(provider.apiKey !== undefined ? { apiKey: provider.apiKey } : {}),
  }
}

export type AiProviderIssueReason =
  /** Not an object, or no string `id` — it never became an entry. */
  | 'malformed-entry'
  | 'invalid-id'
  | 'duplicate-id'
  | 'unknown-extends'
  | 'extends-cycle'
  | 'extends-depth'
  | 'no-protocol'
  | 'unknown-default-protocol'

/** A configuration problem worth surfacing. Never swallowed silently. */
export interface AiProviderIssue {
  readonly providerId: string
  readonly reason: AiProviderIssueReason
  /** The provider was skipped entirely and serves no models. */
  readonly fatal: boolean
  readonly detail?: string
}

export interface AiResolveProvidersResult {
  readonly providers: readonly AiResolvedProvider[]
  readonly issues: readonly AiProviderIssue[]
}

/** Longest `extends` chain, counted in entries: an entry plus at most 7 ancestors. */
const MAX_EXTENDS_DEPTH = 8

/**
 * Merge a user knowledge base over the built-in one, per key and per field, so
 * overriding one field does not force copying the whole entry.
 */
export function mergeModelKnowledge(
  builtin: Readonly<Record<string, AiModelKnowledge>>,
  user: Readonly<Record<string, AiModelKnowledge>> | undefined,
): Readonly<Record<string, AiModelKnowledge>> {
  if (user === undefined) return builtin
  const merged: Record<string, AiModelKnowledge> = { ...builtin }
  for (const [key, entry] of Object.entries(user)) {
    const base = merged[key]
    merged[key] = base === undefined ? entry : { ...base, ...entry }
  }
  return merged
}

/** Flatten `extends` chains and apply the knowledge base, reporting every problem found. */
export function resolveProviderEntries(
  entries: readonly AiProviderEntry[],
  knowledge: Readonly<Record<string, AiModelKnowledge>>,
): AiResolveProvidersResult {
  const issues: AiProviderIssue[] = []
  const byId = new Map<string, AiProviderEntry>()
  for (const entry of entries) {
    // An id with a '/' would make `providerId/protocol/channelModel` unparseable,
    // so every model it serves would be unusable — reported, never dropped quietly.
    if (entry.id === '' || entry.id.includes('/')) {
      issues.push({ providerId: entry.id, reason: 'invalid-id', fatal: true })
      continue
    }
    if (byId.has(entry.id)) {
      issues.push({ providerId: entry.id, reason: 'duplicate-id', fatal: true })
      continue
    }
    byId.set(entry.id, entry)
  }

  const providers: AiResolvedProvider[] = []
  for (const entry of byId.values()) {
    const flattened = flattenExtends(entry, byId, issues)
    if (flattened === undefined) continue
    const resolved = resolveOne(flattened, knowledge, issues)
    if (resolved !== undefined) providers.push(resolved)
  }
  return { providers, issues }
}

function flattenExtends(
  entry: AiProviderEntry,
  byId: ReadonlyMap<string, AiProviderEntry>,
  issues: AiProviderIssue[],
): AiProviderEntry | undefined {
  const chain: AiProviderEntry[] = [entry]
  const seen = new Set<string>([entry.id])
  let current = entry
  while (current.extends !== undefined) {
    const parent = byId.get(current.extends)
    if (parent === undefined) {
      issues.push({
        providerId: entry.id,
        reason: 'unknown-extends',
        fatal: true,
        detail: current.extends,
      })
      return undefined
    }
    if (seen.has(parent.id)) {
      issues.push({ providerId: entry.id, reason: 'extends-cycle', fatal: true, detail: parent.id })
      return undefined
    }
    if (chain.length >= MAX_EXTENDS_DEPTH) {
      issues.push({ providerId: entry.id, reason: 'extends-depth', fatal: true })
      return undefined
    }
    seen.add(parent.id)
    chain.push(parent)
    current = parent
  }

  // Walk root-first so nearer layers overwrite. protocolMap replaces wholesale —
  // an availability list is not something you merge piecewise.
  const merged: {
    -readonly [K in keyof AiProviderEntry]: AiProviderEntry[K]
  } = { id: entry.id }
  for (let i = chain.length - 1; i >= 0; i--) {
    const layer = chain[i]
    if (layer === undefined) continue
    if (layer.baseUrl !== undefined) merged.baseUrl = layer.baseUrl
    if (layer.apiKey !== undefined) merged.apiKey = layer.apiKey
    if (layer.defaultProtocol !== undefined) merged.defaultProtocol = layer.defaultProtocol
    if (layer.protocolMap !== undefined) merged.protocolMap = layer.protocolMap
    if (layer.pricingSource !== undefined) merged.pricingSource = layer.pricingSource
    if (layer.usageSource !== undefined) merged.usageSource = layer.usageSource
  }
  return merged
}

function resolveOne(
  entry: AiProviderEntry,
  knowledge: Readonly<Record<string, AiModelKnowledge>>,
  issues: AiProviderIssue[],
): AiResolvedProvider | undefined {
  const protocols: AiResolvedProtocol[] = []
  for (const [protocol, refs] of Object.entries(entry.protocolMap ?? {})) {
    if (refs === undefined) continue
    protocols.push({
      protocol: protocol as AiWireProtocol,
      models: refs.map((ref) => resolveModelRef(ref, knowledge)),
      discover: refs.length === 0,
    })
  }
  if (protocols.length === 0) {
    issues.push({ providerId: entry.id, reason: 'no-protocol', fatal: true })
    return undefined
  }

  const first = protocols[0]
  if (first === undefined) return undefined
  let defaultProtocol = first.protocol
  if (entry.defaultProtocol !== undefined) {
    if (protocols.some((p) => p.protocol === entry.defaultProtocol)) {
      defaultProtocol = entry.defaultProtocol
    } else {
      issues.push({
        providerId: entry.id,
        reason: 'unknown-default-protocol',
        fatal: false,
        detail: entry.defaultProtocol,
      })
    }
  }

  return {
    id: entry.id,
    ...(entry.baseUrl !== undefined ? { baseUrl: entry.baseUrl } : {}),
    ...(entry.apiKey !== undefined ? { apiKey: entry.apiKey } : {}),
    defaultProtocol,
    protocols,
    ...(entry.pricingSource !== undefined ? { pricingSource: entry.pricingSource } : {}),
    ...(entry.usageSource !== undefined ? { usageSource: entry.usageSource } : {}),
  }
}

function resolveModelRef(
  ref: AiProtocolModelRef,
  knowledge: Readonly<Record<string, AiModelKnowledge>>,
): AiResolvedProtocolModel {
  if (typeof ref === 'string') {
    return { channelModel: ref, ref, knowledge: lookupModelKnowledge(knowledge, ref) ?? {} }
  }
  const key = ref.ref ?? ref.id ?? ''
  const channelModel = ref.id ?? key
  return {
    channelModel,
    ref: key,
    knowledge: applyOverride(lookupModelKnowledge(knowledge, key), ref),
  }
}

function applyOverride(
  base: AiModelKnowledge | undefined,
  override: AiProtocolModelOverride,
): AiModelKnowledge {
  const { id: _id, ref: _ref, capabilities, ...rest } = override
  const merged: AiModelKnowledge = { ...base }
  for (const [key, value] of Object.entries(rest)) {
    if (value !== undefined) (merged as Record<string, unknown>)[key] = value
  }
  const mergedCapabilities = narrowCapabilities(base?.capabilities, capabilities)
  return mergedCapabilities === undefined ? merged : { ...merged, capabilities: mergedCapabilities }
}

/**
 * A channel can only take capabilities away, never add them: a translation layer
 * loses features (prompt caching, thinking blocks), it cannot invent them.
 */
function narrowCapabilities(
  base: AiModelCapabilities | undefined,
  override: AiModelCapabilities | undefined,
): AiModelCapabilities | undefined {
  if (override === undefined) return base
  if (base === undefined) return undefined
  const narrowed: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override)) {
    if (value === false) narrowed[key] = false
  }
  return narrowed as unknown as AiModelCapabilities
}
