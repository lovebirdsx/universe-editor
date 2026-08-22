/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Pure provider registry: wire protocol → provider, plus a set of active
 *  provider instances (type/name) whose models are resolved lazily and cached
 *  per instance, with per-instance concurrency dedup. Models within one instance
 *  are bucketed by their effective (protocol, baseUrl) and handed to the
 *  matching protocol's provider. No IPC / Electron dependency, so it can be
 *  unit-tested in plain node. Held by AiModelMainService.
 *--------------------------------------------------------------------------------------------*/

import type { CancellationToken } from '../base/cancellation.js'
import { Emitter, type Event } from '../base/event.js'
import { Disposable, type IDisposable, toDisposable } from '../base/lifecycle.js'
import {
  providerKey,
  type AiCustomModelConfig,
  type AiResolvedProvider,
} from './aiModelConfiguration.js'
import type { IAiModelProvider } from './aiModelProvider.js'
import type { AiModelMetadata, AiModelSelector, AiWireProtocol } from './aiModelTypes.js'

interface Bucket {
  readonly protocol: AiWireProtocol
  readonly baseUrl?: string
  models: AiCustomModelConfig[]
}

interface Entry {
  readonly provider: AiResolvedProvider
  /** Resolved models for this instance, or undefined when not yet resolved. */
  models: readonly AiModelMetadata[] | undefined
  /** model id → the protocol provider + bucket view that produced it. */
  byModelId: Map<string, { provider: IAiModelProvider; view: AiResolvedProvider }>
  /** In-flight resolution, shared across concurrent callers (dedup). */
  pending: Promise<readonly AiModelMetadata[]> | undefined
}

export class AiModelRegistry extends Disposable {
  private readonly _providers = new Map<AiWireProtocol, IAiModelProvider>()
  private readonly _entries = new Map<string, Entry>()

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
   * Replace the active instance set, invalidating all cached model lists (a
   * change is typically a config or key change, both of which require re-enumeration).
   * Always fires onDidChangeModels.
   */
  setProviders(providers: readonly AiResolvedProvider[]): void {
    this._entries.clear()
    for (const provider of providers) {
      this._entries.set(providerKey(provider), freshEntry(provider))
    }
    this._onDidChangeModels.fire()
  }

  /** Resolve (lazily, cached, dedup'd) all models across every active instance. */
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

  /** Find the protocol provider + bucket view that own `modelId` (resolving caches as needed). */
  async resolveModel(
    modelId: string,
    token: CancellationToken,
  ): Promise<
    { readonly provider: IAiModelProvider; readonly resolved: AiResolvedProvider } | undefined
  > {
    for (const entry of this._entries.values()) {
      const models = await this._resolveEntry(entry, token)
      if (models.some((m) => m.id === modelId)) {
        const info = entry.byModelId.get(modelId)
        if (info) return { provider: info.provider, resolved: info.view }
      }
    }
    return undefined
  }

  private _resolveEntry(
    entry: Entry,
    token: CancellationToken,
  ): Promise<readonly AiModelMetadata[]> {
    if (entry.models) return Promise.resolve(entry.models)
    if (entry.pending) return entry.pending

    const key = providerKey(entry.provider)
    const pending = this._resolveEntryUncached(entry, token)
      .then(({ models, byModelId }) => {
        // Only commit the cache if this entry is still the active one for its key.
        if (this._entries.get(key) === entry && entry.pending === pending) {
          entry.models = models
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
    byModelId: Map<string, { provider: IAiModelProvider; view: AiResolvedProvider }>
  }> {
    const instance = entry.provider
    const models: AiModelMetadata[] = []
    const byModelId = new Map<string, { provider: IAiModelProvider; view: AiResolvedProvider }>()
    const seen = new Set<string>()
    for (const bucket of bucketModels(instance)) {
      const provider = this._providers.get(bucket.protocol)
      if (!provider) continue
      const view: AiResolvedProvider = {
        ...instance,
        protocol: bucket.protocol,
        ...(bucket.baseUrl !== undefined ? { baseUrl: bucket.baseUrl } : {}),
        declaredModels: bucket.models,
      }
      const provided = await provider.provideModels(view, token)
      for (const m of provided) {
        if (seen.has(m.id)) continue
        seen.add(m.id)
        models.push({ ...m, protocol: bucket.protocol })
        byModelId.set(m.id, { provider, view })
      }
    }
    return { models, byModelId }
  }

  override dispose(): void {
    this._providers.clear()
    this._entries.clear()
    super.dispose()
  }
}

function freshEntry(provider: AiResolvedProvider): Entry {
  return { provider, models: undefined, byModelId: new Map(), pending: undefined }
}

function bucketModels(instance: AiResolvedProvider): readonly Bucket[] {
  const buckets = new Map<string, Bucket>()
  buckets.set(bucketKey(instance.protocol, instance.baseUrl), {
    protocol: instance.protocol,
    ...(instance.baseUrl !== undefined ? { baseUrl: instance.baseUrl } : {}),
    models: [],
  })
  for (const model of instance.declaredModels ?? []) {
    const protocol = model.protocol ?? instance.protocol
    const baseUrl = model.baseUrl ?? instance.baseUrl
    const key = bucketKey(protocol, baseUrl)
    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = { protocol, ...(baseUrl !== undefined ? { baseUrl } : {}), models: [] }
      buckets.set(key, bucket)
    }
    bucket.models.push(model)
  }
  return [...buckets.values()]
}

function bucketKey(protocol: AiWireProtocol, baseUrl: string | undefined): string {
  return `${protocol}\u0000${baseUrl ?? ''}`
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
