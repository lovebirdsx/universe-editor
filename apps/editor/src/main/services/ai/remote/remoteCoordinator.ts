/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Orchestrates the pluggable remote AI sources: knows which providers need
 *  what and when to fetch it, but never participates in the hot path (the
 *  renderer reads a synchronous mirror instead). Refresh only happens on an
 *  explicit provider-set change, a manual UI refresh, or a stale cache after
 *  startup; failures keep the previous cache and never surface as errors.
 *--------------------------------------------------------------------------------------------*/

import {
  CancellationTokenSource,
  Disposable,
  Emitter,
  NullLogger,
  providerKey,
  type AiAccountUsage,
  type AiRateTable,
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
    for (const provider of providers) this._providers.set(providerKey(provider), provider)
    const keys = [...this._providers.keys()]
    void this._reconcile(keys).catch(() => undefined)
  }

  /** Refresh one provider (by key) or all of them. Awaits completion; used by the UI's manual refresh. */
  async refresh(providerKey?: string): Promise<void> {
    await this._cache.load()
    const keys = providerKey !== undefined ? [providerKey] : [...this._providers.keys()]
    await this._refreshKeys(keys)
  }

  getRates(key: string): AiRateTable | undefined {
    return this._cache.getRates(key)?.rates
  }

  getUsage(key: string): AiAccountUsage | undefined {
    return this._cache.getUsage(key)
  }

  allRateSnapshots(): readonly {
    readonly providerKey: string
    readonly rates: AiRateTable
    readonly fetchedAt: number
  }[] {
    return this._cache.allRates()
  }

  private async _reconcile(liveKeys: readonly string[]): Promise<void> {
    await this._cache.load()
    this._cache.prune(liveKeys)
    await this._cache.flush()
    await this._refreshStale()
  }

  private async _refreshStale(): Promise<void> {
    const keys: string[] = []
    for (const [key, provider] of this._providers) {
      const needsRates = provider.pricingSource !== undefined && this._cache.isRatesStale(key)
      const needsUsage = provider.usageSource !== undefined && this._cache.isUsageStale(key)
      if (needsRates || needsUsage) keys.push(key)
    }
    if (keys.length === 0) return
    await this._refreshKeys(keys)
  }

  private async _refreshKeys(keys: readonly string[]): Promise<void> {
    let wrote = false
    const results = await Promise.allSettled(keys.map((key) => this._refreshKey(key)))
    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) wrote = true
    }
    await this._cache.flush()
    if (wrote) this._onDidChange.fire()
  }

  /** Concurrent callers for the same key share one in-flight refresh. */
  private _refreshKey(key: string): Promise<boolean> {
    const existing = this._pending.get(key)
    if (existing !== undefined) return existing
    const task = this._doRefreshKey(key).finally(() => {
      this._pending.delete(key)
    })
    this._pending.set(key, task)
    return task
  }

  private async _doRefreshKey(key: string): Promise<boolean> {
    const provider = this._providers.get(key)
    if (provider === undefined) return false
    const tasks: Promise<boolean>[] = []
    if (provider.pricingSource !== undefined) {
      tasks.push(
        this._fetchRates(
          key,
          toFetchContext(provider, provider.pricingSource),
          provider.pricingSource,
        ),
      )
    }
    if (provider.usageSource !== undefined) {
      tasks.push(
        this._fetchUsage(key, toFetchContext(provider, provider.usageSource), provider.usageSource),
      )
    }
    const results = await Promise.allSettled(tasks)
    return results.some((r) => r.status === 'fulfilled' && r.value === true)
  }

  private async _fetchRates(
    key: string,
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
        `ai remote pricing '${spec.id}' failed for ${key}: ${err instanceof Error ? err.message : String(err)}`,
      )
      return false
    }
    if (rates === undefined) return false
    this._cache.setRates(key, rates)
    return true
  }

  private async _fetchUsage(
    key: string,
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
        `ai remote usage '${spec.id}' failed for ${key}: ${err instanceof Error ? err.message : String(err)}`,
      )
      return false
    }
    if (usage === undefined) return false
    this._cache.setUsage(key, usage)
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
    typeId: provider.type,
    instanceName: provider.name,
    ...(provider.baseUrl !== undefined ? { baseUrl: provider.baseUrl } : {}),
    ...(provider.apiKey !== undefined ? { apiKey: provider.apiKey } : {}),
    ...(spec.options !== undefined ? { options: spec.options } : {}),
  }
}
