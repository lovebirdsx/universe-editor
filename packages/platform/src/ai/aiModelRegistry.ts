/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Pure provider registry: vendor → provider, lazy model resolution with cache,
 *  per-vendor invalidation, and per-vendor concurrency dedup. No IPC / Electron
 *  dependency, so it can be unit-tested in plain node. Held by AiModelMainService.
 *--------------------------------------------------------------------------------------------*/

import type { CancellationToken } from '../base/cancellation.js'
import { Emitter, type Event } from '../base/event.js'
import { Disposable, type IDisposable, toDisposable } from '../base/lifecycle.js'
import type { IAiModelProvider } from './aiModelProvider.js'
import type { AiModelMetadata, AiModelSelector } from './aiModelTypes.js'

interface ProviderEntry {
  readonly provider: IAiModelProvider
  readonly sub?: IDisposable
  /** Resolved models for this vendor, or undefined when not yet resolved. */
  models: readonly AiModelMetadata[] | undefined
  /** In-flight resolution, shared across concurrent callers (dedup). */
  pending: Promise<readonly AiModelMetadata[]> | undefined
}

export class AiModelRegistry extends Disposable {
  private readonly _providers = new Map<string, ProviderEntry>()

  private readonly _onDidChangeModels = this._register(new Emitter<void>())
  readonly onDidChangeModels: Event<void> = this._onDidChangeModels.event

  registerProvider(vendor: string, provider: IAiModelProvider): IDisposable {
    if (this._providers.has(vendor)) {
      throw new Error(`AI provider for vendor '${vendor}' is already registered`)
    }
    const sub = provider.onDidChange?.(() => this._invalidate(vendor))
    const entry: ProviderEntry = sub
      ? { provider, sub, models: undefined, pending: undefined }
      : { provider, models: undefined, pending: undefined }
    this._providers.set(vendor, entry)
    this._onDidChangeModels.fire()
    return toDisposable(() => {
      const current = this._providers.get(vendor)
      if (current !== entry) return
      this._providers.delete(vendor)
      current.sub?.dispose()
      this._onDidChangeModels.fire()
    })
  }

  getProvider(vendor: string): IAiModelProvider | undefined {
    return this._providers.get(vendor)?.provider
  }

  /** Resolve (lazily, cached, dedup'd) all models across every provider. */
  async getModels(token: CancellationToken): Promise<readonly AiModelMetadata[]> {
    const lists = await Promise.all(
      [...this._providers.keys()].map((vendor) => this._resolveVendor(vendor, token)),
    )
    return lists.flat()
  }

  async selectModels(
    selector: AiModelSelector,
    token: CancellationToken,
  ): Promise<readonly string[]> {
    const models = selector.vendor
      ? await this._resolveVendor(selector.vendor, token)
      : await this.getModels(token)
    return models.filter((m) => matchesSelector(m, selector)).map((m) => m.id)
  }

  /** Find the provider that owns `modelId` (resolving caches as needed). */
  async providerForModel(
    modelId: string,
    token: CancellationToken,
  ): Promise<IAiModelProvider | undefined> {
    for (const vendor of this._providers.keys()) {
      const models = await this._resolveVendor(vendor, token)
      if (models.some((m) => m.id === modelId)) {
        return this._providers.get(vendor)?.provider
      }
    }
    return undefined
  }

  private _resolveVendor(
    vendor: string,
    token: CancellationToken,
  ): Promise<readonly AiModelMetadata[]> {
    const entry = this._providers.get(vendor)
    if (!entry) return Promise.resolve([])
    if (entry.models) return Promise.resolve(entry.models)
    if (entry.pending) return entry.pending

    const pending = entry.provider
      .provideModels(token)
      .then((models) => {
        // Only commit the cache if this resolution wasn't invalidated meanwhile.
        if (this._providers.get(vendor) === entry && entry.pending === pending) {
          entry.models = models
          entry.pending = undefined
        }
        return models
      })
      .catch((err: unknown) => {
        if (this._providers.get(vendor) === entry && entry.pending === pending) {
          entry.pending = undefined
        }
        throw err
      })
    entry.pending = pending
    return pending
  }

  private _invalidate(vendor: string): void {
    const entry = this._providers.get(vendor)
    if (!entry) return
    entry.models = undefined
    entry.pending = undefined
    this._onDidChangeModels.fire()
  }

  override dispose(): void {
    for (const entry of this._providers.values()) {
      entry.sub?.dispose()
    }
    this._providers.clear()
    super.dispose()
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
