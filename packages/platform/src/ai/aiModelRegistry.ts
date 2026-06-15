/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Pure provider registry: vendor → provider, plus a set of active provider
 *  groups (vendor/name) whose models are resolved lazily and cached per group,
 *  with per-group concurrency dedup. No IPC / Electron dependency, so it can be
 *  unit-tested in plain node. Held by AiModelMainService.
 *--------------------------------------------------------------------------------------------*/

import type { CancellationToken } from '../base/cancellation.js'
import { Emitter, type Event } from '../base/event.js'
import { Disposable, type IDisposable, toDisposable } from '../base/lifecycle.js'
import { groupKey, type AiResolvedGroup } from './aiModelConfiguration.js'
import type { IAiModelProvider } from './aiModelProvider.js'
import type { AiModelMetadata, AiModelSelector } from './aiModelTypes.js'

interface GroupEntry {
  readonly group: AiResolvedGroup
  /** Resolved models for this group, or undefined when not yet resolved. */
  models: readonly AiModelMetadata[] | undefined
  /** In-flight resolution, shared across concurrent callers (dedup). */
  pending: Promise<readonly AiModelMetadata[]> | undefined
}

export class AiModelRegistry extends Disposable {
  private readonly _providers = new Map<string, IAiModelProvider>()
  private readonly _groups = new Map<string, GroupEntry>()

  private readonly _onDidChangeModels = this._register(new Emitter<void>())
  readonly onDidChangeModels: Event<void> = this._onDidChangeModels.event

  registerProvider(vendor: string, provider: IAiModelProvider): IDisposable {
    if (this._providers.has(vendor)) {
      throw new Error(`AI provider for vendor '${vendor}' is already registered`)
    }
    this._providers.set(vendor, provider)
    this._onDidChangeModels.fire()
    return toDisposable(() => {
      if (this._providers.get(vendor) !== provider) return
      this._providers.delete(vendor)
      this._onDidChangeModels.fire()
    })
  }

  getProvider(vendor: string): IAiModelProvider | undefined {
    return this._providers.get(vendor)
  }

  /**
   * Replace the active group set, invalidating all cached model lists (a group
   * change is typically a config or key change, both of which require re-enumeration).
   * Always fires onDidChangeModels.
   */
  setGroups(groups: readonly AiResolvedGroup[]): void {
    this._groups.clear()
    for (const group of groups) {
      this._groups.set(groupKey(group), freshEntry(group))
    }
    this._onDidChangeModels.fire()
  }

  /** Resolve (lazily, cached, dedup'd) all models across every active group. */
  async getModels(token: CancellationToken): Promise<readonly AiModelMetadata[]> {
    const lists = await Promise.all(
      [...this._groups.values()].map((entry) => this._resolveGroup(entry, token)),
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

  /** Find the provider + group that own `modelId` (resolving caches as needed). */
  async resolveModel(
    modelId: string,
    token: CancellationToken,
  ): Promise<{ readonly provider: IAiModelProvider; readonly group: AiResolvedGroup } | undefined> {
    for (const entry of this._groups.values()) {
      const provider = this._providers.get(entry.group.vendor)
      if (!provider) continue
      const models = await this._resolveGroup(entry, token)
      if (models.some((m) => m.id === modelId)) {
        return { provider, group: entry.group }
      }
    }
    return undefined
  }

  private _resolveGroup(
    entry: GroupEntry,
    token: CancellationToken,
  ): Promise<readonly AiModelMetadata[]> {
    const provider = this._providers.get(entry.group.vendor)
    if (!provider) return Promise.resolve([])
    if (entry.models) return Promise.resolve(entry.models)
    if (entry.pending) return entry.pending

    const key = groupKey(entry.group)
    const pending = provider
      .provideModels(entry.group, token)
      .then((models) => {
        // Only commit the cache if this entry is still the active one for its key.
        if (this._groups.get(key) === entry && entry.pending === pending) {
          entry.models = models
          entry.pending = undefined
        }
        return models
      })
      .catch((err: unknown) => {
        if (this._groups.get(key) === entry && entry.pending === pending) {
          entry.pending = undefined
        }
        throw err
      })
    entry.pending = pending
    return pending
  }

  override dispose(): void {
    this._providers.clear()
    this._groups.clear()
    super.dispose()
  }
}

function freshEntry(group: AiResolvedGroup): GroupEntry {
  return { group, models: undefined, pending: undefined }
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
