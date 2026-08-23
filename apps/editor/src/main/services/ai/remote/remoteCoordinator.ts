/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Orchestrates the pluggable remote AI sources: knows which providers need
 *  what and when to fetch it, but never participates in the hot path (the
 *  renderer reads a synchronous mirror instead). Refresh only happens on an
 *  explicit provider-set change, a manual UI refresh, or a stale cache after
 *  startup; failures keep the previous cache and never surface as errors.
 *  A `sync` source (the built-in catalog) is a pure table lookup — it is skipped
 *  by the fetch/cache machinery entirely.
 *--------------------------------------------------------------------------------------------*/

import {
  CancellationTokenSource,
  Disposable,
  Emitter,
  NullLogger,
  type AiAccountUsage,
  type AiRateTable,
  type AiRateTableSnapshot,
  type AiRemoteSourceRegistry,
  type AiRemoteSourceSpec,
  type AiResolvedProvider,
  type AiSourceFetchContext,
  type CancellationToken,
  type Event,
  type ILogger,
} from '@universe-editor/platform'
import { AiRemoteCache } from './remoteCache.js'

const FETCH_TIMEOUT_MS = 30_000

export interface AiRemoteCoordinatorOptions {
  readonly registry: AiRemoteSourceRegistry
  readonly cache: AiRemoteCache
  readonly logger?: ILogger
}

export class AiRemoteCoordinator extends Disposable {
  private readonly _logger: ILogger
  private readonly _registry: AiRemoteSourceRegistry
  private readonly _cache: AiRemoteCache
  private readonly _providers = new Map<string, AiResolvedProvider>()
  private readonly _pending = new Map<string, Promise<boolean>>()
  private readonly _inflight = new Set<CancellationTokenSource>()

  private readonly _onDidChange = this._register(new Emitter<void>())
  readonly onDidChange: Event<void> = this._onDidChange.event

  constructor(options: AiRemoteCoordinatorOptions) {
    super()
    this._registry = options.registry
    this._cache = options.cache
    this._logger = options.logger ?? new NullLogger()
  }

  /**
   * Called whenever the resolved provider set changes; prunes the cache and kicks
   * a background refresh of stale entries.
   */
  setProviders(providers: readonly AiResolvedProvider[]): void {
    this._providers.clear()
    for (const provider of providers) this._providers.set(provider.id, provider)
    const ids = [...this._providers.keys()]
    void this._reconcile(ids).catch(() => undefined)
  }

  /** Refresh one provider (by id) or all of them. Awaits completion; used by the UI's manual refresh. */
  async refresh(providerId?: string): Promise<void> {
    await this._cache.load()
    const ids = providerId !== undefined ? [providerId] : [...this._providers.keys()]
    await this._refreshIds(ids)
  }

  getRates(providerId: string): AiRateTable | undefined {
    return this._cache.getRates(providerId)?.rates
  }

  getUsage(providerId: string): AiAccountUsage | undefined {
    return this._cache.getUsage(providerId)
  }

  allRateSnapshots(): readonly AiRateTableSnapshot[] {
    return this._cache.allRates()
  }

  private async _reconcile(liveIds: readonly string[]): Promise<void> {
    await this._cache.load()
    this._cache.prune(liveIds)
    await this._cache.flush()
    await this._refreshStale()
  }

  private async _refreshStale(): Promise<void> {
    const ids: string[] = []
    for (const [id, provider] of this._providers) {
      const needsRates =
        provider.pricingSource !== undefined &&
        !this._isSyncPricing(provider.pricingSource) &&
        this._cache.isRatesStale(id)
      const needsUsage =
        provider.usageSource !== undefined &&
        !this._isSyncUsage(provider.usageSource) &&
        this._cache.isUsageStale(id)
      if (needsRates || needsUsage) ids.push(id)
    }
    if (ids.length === 0) return
    await this._refreshIds(ids)
  }

  private async _refreshIds(ids: readonly string[]): Promise<void> {
    let wrote = false
    const results = await Promise.allSettled(ids.map((id) => this._refreshId(id)))
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) wrote = true
    }
    await this._cache.flush()
    if (wrote) this._onDidChange.fire()
  }

  /** Concurrent callers for the same id share one in-flight refresh. */
  private _refreshId(id: string): Promise<boolean> {
    const existing = this._pending.get(id)
    if (existing !== undefined) return existing
    const task = this._doRefreshId(id).finally(() => {
      this._pending.delete(id)
    })
    this._pending.set(id, task)
    return task
  }

  private async _doRefreshId(id: string): Promise<boolean> {
    const provider = this._providers.get(id)
    if (provider === undefined) return false
    const tasks: Promise<boolean>[] = []
    if (provider.pricingSource !== undefined && !this._isSyncPricing(provider.pricingSource)) {
      tasks.push(
        this._fetchRates(
          id,
          toFetchContext(provider, provider.pricingSource),
          provider.pricingSource,
        ),
      )
    }
    if (provider.usageSource !== undefined && !this._isSyncUsage(provider.usageSource)) {
      tasks.push(
        this._fetchUsage(id, toFetchContext(provider, provider.usageSource), provider.usageSource),
      )
    }
    const results = await Promise.allSettled(tasks)
    return results.some((r) => r.status === 'fulfilled' && r.value === true)
  }

  private _isSyncPricing(spec: AiRemoteSourceSpec): boolean {
    const source = this._registry.getPricingSource(spec.id)
    return source !== undefined && (source as { readonly sync?: boolean }).sync === true
  }

  private _isSyncUsage(spec: AiRemoteSourceSpec): boolean {
    const source = this._registry.getUsageSource(spec.id)
    return source !== undefined && (source as { readonly sync?: boolean }).sync === true
  }

  private async _fetchRates(
    id: string,
    ctx: AiSourceFetchContext,
    spec: AiRemoteSourceSpec,
  ): Promise<boolean> {
    const source = this._registry.getPricingSource(spec.id)
    if (source === undefined) {
      this._logger.warn(`ai remote: no pricing source '${spec.id}' registered`)
      return false
    }
    let rates: AiRateTable | undefined
    try {
      rates = await this._withTimeout((token) => source.fetchRates(ctx, token))
    } catch (err) {
      this._logger.warn(
        `ai remote pricing '${spec.id}' failed for ${id}: ${err instanceof Error ? err.message : String(err)}`,
      )
      return false
    }
    if (rates === undefined) return false
    this._cache.setRates(id, rates)
    return true
  }

  private async _fetchUsage(
    id: string,
    ctx: AiSourceFetchContext,
    spec: AiRemoteSourceSpec,
  ): Promise<boolean> {
    const source = this._registry.getUsageSource(spec.id)
    if (source === undefined) {
      this._logger.warn(`ai remote: no usage source '${spec.id}' registered`)
      return false
    }
    let usage: AiAccountUsage | undefined
    try {
      usage = await this._withTimeout((token) => source.fetchUsage(ctx, token))
    } catch (err) {
      this._logger.warn(
        `ai remote usage '${spec.id}' failed for ${id}: ${err instanceof Error ? err.message : String(err)}`,
      )
      return false
    }
    if (usage === undefined) return false
    this._cache.setUsage(id, usage)
    return true
  }

  private async _withTimeout<T>(fn: (token: CancellationToken) => Promise<T>): Promise<T> {
    const cts = new CancellationTokenSource()
    this._inflight.add(cts)
    const timer = setTimeout(() => cts.cancel(), FETCH_TIMEOUT_MS)
    try {
      return await fn(cts.token)
    } finally {
      clearTimeout(timer)
      this._inflight.delete(cts)
      cts.dispose()
    }
  }

  override dispose(): void {
    for (const cts of this._inflight) {
      cts.cancel()
      cts.dispose()
    }
    this._inflight.clear()
    this._pending.clear()
    super.dispose()
  }
}

function toFetchContext(
  provider: AiResolvedProvider,
  spec: AiRemoteSourceSpec,
): AiSourceFetchContext {
  return {
    typeId: provider.id,
    instanceName: provider.id,
    ...(provider.baseUrl !== undefined ? { baseUrl: provider.baseUrl } : {}),
    ...(provider.apiKey !== undefined ? { apiKey: provider.apiKey } : {}),
    ...(spec.options !== undefined ? { options: spec.options } : {}),
  }
}
