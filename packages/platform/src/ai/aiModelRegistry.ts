/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Pure provider registry: wire protocol → provider implementation, plus the set
 *  of active provider entries. Each entry's `protocolMap` already says which
 *  protocols it speaks and which models each one exposes, so there is nothing to
 *  bucket: a declared list is stamped straight into metadata without touching the
 *  network, and only a `[]` protocol asks its provider to enumerate. No IPC /
 *  Electron dependency, so it can be unit-tested in plain node.
 *--------------------------------------------------------------------------------------------*/

import type { CancellationToken } from '../base/cancellation.js'
import { Emitter, type Event } from '../base/event.js'
import { Disposable, type IDisposable, toDisposable } from '../base/lifecycle.js'
import { buildModelConfigSchema, composeModelId } from './aiModelConfiguration.js'
import {
  protocolRuntime,
  type AiModelKnowledge,
  type AiProviderRuntime,
  type AiResolvedProtocolModel,
  type AiResolvedProvider,
} from './aiProviderEntry.js'
import {
  computeKnowledgeFingerprint,
  computeProviderModelFingerprint,
} from './aiModelFingerprint.js'
import type { IAiModelProvider } from './aiModelProvider.js'
import type { AiModelMetadata, AiModelSelector, AiWireProtocol } from './aiModelTypes.js'

/** Fallbacks for a model no knowledge base knows; each protocol's own norm. */
const PROTOCOL_TOKEN_DEFAULTS: Readonly<
  Record<AiWireProtocol, { readonly input: number; readonly output: number }>
> = {
  'anthropic-messages': { input: 200000, output: 64000 },
  'openai-chat': { input: 8192, output: 8192 },
  'openai-responses': { input: 8192, output: 8192 },
  ollama: { input: 4096, output: 4096 },
}

interface Entry {
  /** Mutated in place when a reload keeps this entry: the newest resolved provider. */
  provider: AiResolvedProvider
  /** Content fingerprint the cached models were resolved against. */
  readonly modelFingerprint: string
  /** Resolved models for this entry, or undefined when not yet resolved. */
  models: readonly AiModelMetadata[] | undefined
  /** model id → the protocol provider + runtime view that produced it. */
  byModelId: Map<string, { provider: IAiModelProvider; runtime: AiProviderRuntime }>
  /** In-flight resolution, shared across concurrent callers (dedup). */
  pending: Promise<readonly AiModelMetadata[]> | undefined
}

export class AiModelRegistry extends Disposable {
  private readonly _providers = new Map<AiWireProtocol, IAiModelProvider>()
  private _entries = new Map<string, Entry>()
  private _knowledge: Readonly<Record<string, AiModelKnowledge>> = {}
  private _knowledgeFingerprint = computeKnowledgeFingerprint({})

  private readonly _onDidChangeModels = this._register(new Emitter<void>())
  readonly onDidChangeModels: Event<void> = this._onDidChangeModels.event

  registerProvider(protocol: AiWireProtocol, provider: IAiModelProvider): IDisposable {
    if (this._providers.has(protocol)) {
      throw new Error(`AI provider for protocol '${protocol}' is already registered`)
    }
    this._providers.set(protocol, provider)
    this._onDidChangeModels.fire()
    return toDisposable(() => {
      if (this._providers.get(protocol) !== provider) return
      this._providers.delete(protocol)
      this._onDidChangeModels.fire()
    })
  }

  getProvider(protocol: AiWireProtocol): IAiModelProvider | undefined {
    return this._providers.get(protocol)
  }

  /** Protocols with a registered provider. */
  getProtocols(): readonly AiWireProtocol[] {
    return [...this._providers.keys()]
  }

  /**
   * Replace the active entry set, keeping each provider's cached model list when
   * its model-affecting fields are unchanged (see aiModelFingerprint) — a reload
   * of an unrelated field such as pricingSource should not trigger another
   * network enumeration. Declared entries carry their knowledge inline, so a
   * knowledge-base change shifts their fingerprint on its own; discovered
   * entries merge the base at enumeration time, which is why a knowledge change
   * additionally invalidates every entry. Always fires onDidChangeModels.
   */
  setProviders(
    providers: readonly AiResolvedProvider[],
    knowledge?: Readonly<Record<string, AiModelKnowledge>>,
  ): void {
    let knowledgeChanged = false
    if (knowledge !== undefined) {
      const fingerprint = computeKnowledgeFingerprint(knowledge)
      knowledgeChanged = fingerprint !== this._knowledgeFingerprint
      this._knowledge = knowledge
      this._knowledgeFingerprint = fingerprint
    }

    const next = new Map<string, Entry>()
    for (const provider of providers) {
      const fingerprint = computeProviderModelFingerprint(provider)
      // Duplicate ids keep the long-standing "last one wins" Map semantics:
      // the candidate to reuse is whichever entry the map currently holds.
      const old = knowledgeChanged
        ? undefined
        : (next.get(provider.id) ?? this._entries.get(provider.id))
      next.set(provider.id, reuseEntry(old, provider, fingerprint))
    }
    this._entries = next
    this._onDidChangeModels.fire()
  }

  /** Resolve (lazily, cached, dedup'd) all models across every active entry. */
  async getModels(token: CancellationToken): Promise<readonly AiModelMetadata[]> {
    const lists = await Promise.all(
      [...this._entries.values()].map((entry) => this._resolveEntry(entry, token)),
    )
    return lists.flat()
  }

  async selectModels(
    selector: AiModelSelector,
    token: CancellationToken,
  ): Promise<readonly string[]> {
    const models = await this.getModels(token)
    return models.filter((m) => matchesSelector(m, selector)).map((m) => m.id)
  }

  /** Find the protocol provider + runtime view that own `modelId` (resolving caches as needed). */
  async resolveModel(
    modelId: string,
    token: CancellationToken,
  ): Promise<
    { readonly provider: IAiModelProvider; readonly runtime: AiProviderRuntime } | undefined
  > {
    for (const entry of this._entries.values()) {
      await this._resolveEntry(entry, token)
      const info = entry.byModelId.get(modelId)
      if (info) return { provider: info.provider, runtime: info.runtime }
    }
    return undefined
  }

  private _resolveEntry(
    entry: Entry,
    token: CancellationToken,
  ): Promise<readonly AiModelMetadata[]> {
    if (entry.models) return Promise.resolve(entry.models)
    if (entry.pending) return entry.pending

    const key = entry.provider.id
    const pending = this._resolveEntryUncached(entry, token)
      .then(({ models, byModelId, incomplete }) => {
        // Only commit the cache if this entry is still the active one for its id,
        // and discovery actually saw the endpoint: caching a degraded result would
        // pin an offline gateway to "no models" until the next setProviders.
        if (this._entries.get(key) === entry && entry.pending === pending) {
          if (!incomplete) entry.models = models
          entry.byModelId = byModelId
          entry.pending = undefined
        }
        return models
      })
      .catch((err: unknown) => {
        if (this._entries.get(key) === entry && entry.pending === pending) {
          entry.pending = undefined
        }
        throw err
      })
    entry.pending = pending
    return pending
  }

  private async _resolveEntryUncached(
    entry: Entry,
    token: CancellationToken,
  ): Promise<{
    models: readonly AiModelMetadata[]
    byModelId: Map<string, { provider: IAiModelProvider; runtime: AiProviderRuntime }>
    /** A discovery call failed, so this resolution must not be cached. */
    incomplete: boolean
  }> {
    const { provider: resolved } = entry
    const models: AiModelMetadata[] = []
    const byModelId = new Map<string, { provider: IAiModelProvider; runtime: AiProviderRuntime }>()
    let incomplete = false

    for (const declaration of resolved.protocols) {
      const impl = this._providers.get(declaration.protocol)
      if (!impl) continue
      const runtime = protocolRuntime(resolved, declaration.protocol)
      let entries: readonly AiResolvedProtocolModel[]
      if (declaration.discover) {
        // Discovery is best-effort: an offline or unauthorized endpoint contributes
        // no models rather than failing the whole catalogue. Probing (verifyProvider)
        // is where the reason surfaces.
        const discovered = await impl.listModels(runtime, token).catch(() => {
          incomplete = true
          return [] as readonly string[]
        })
        entries = discovered.map((name) => this._discovered(name))
      } else {
        entries = declaration.models
      }

      for (const model of entries) {
        const id = composeModelId(resolved.id, declaration.protocol, model.channelModel)
        if (byModelId.has(id)) continue
        models.push(toMetadata(id, resolved.id, declaration.protocol, model))
        byModelId.set(id, { provider: impl, runtime })
      }
    }
    return { models, byModelId, incomplete }
  }

  private _discovered(channelModel: string): AiResolvedProtocolModel {
    return {
      channelModel,
      ref: channelModel,
      knowledge: this._knowledge[channelModel] ?? {},
    }
  }

  override dispose(): void {
    this._providers.clear()
    this._entries.clear()
    super.dispose()
  }
}

/**
 * Carry the cached resolution over when the entry still serves the same models:
 * mutating the old entry in place keeps an in-flight `pending` promise valid
 * (its commit check matches by identity).
 */
function reuseEntry(
  old: Entry | undefined,
  provider: AiResolvedProvider,
  fingerprint: string,
): Entry {
  if (old !== undefined && old.modelFingerprint === fingerprint) {
    old.provider = provider
    return old
  }
  return {
    provider,
    modelFingerprint: fingerprint,
    models: undefined,
    byModelId: new Map(),
    pending: undefined,
  }
}

function toMetadata(
  id: string,
  providerId: string,
  protocol: AiWireProtocol,
  model: AiResolvedProtocolModel,
): AiModelMetadata {
  const knowledge = model.knowledge
  const defaults = PROTOCOL_TOKEN_DEFAULTS[protocol]
  const schema = buildModelConfigSchema(knowledge)
  return {
    id,
    providerId,
    protocol,
    channelModel: model.channelModel,
    ...(knowledge.vendor !== undefined ? { vendor: knowledge.vendor } : {}),
    name: knowledge.name ?? model.channelModel,
    family: knowledge.family ?? model.ref,
    maxInputTokens: knowledge.maxInputTokens ?? defaults.input,
    maxOutputTokens: knowledge.maxOutputTokens ?? defaults.output,
    capabilities: knowledge.capabilities ?? { streaming: true },
    ...(schema !== undefined ? { configurationSchema: schema } : {}),
  }
}

function matchesSelector(model: AiModelMetadata, selector: AiModelSelector): boolean {
  if (selector.id !== undefined && model.id !== selector.id) return false
  if (selector.vendor !== undefined && model.vendor !== selector.vendor) return false
  if (selector.family !== undefined && model.family !== selector.family) return false
  if (selector.capabilities) {
    for (const [key, want] of Object.entries(selector.capabilities)) {
      if (want === undefined) continue
      if (model.capabilities[key as keyof typeof model.capabilities] !== want) return false
    }
  }
  return true
}
