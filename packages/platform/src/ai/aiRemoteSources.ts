/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Pluggable remote sources for AI pricing and account-level usage, plus the
 *  pure registry that holds them. Sources are fetched lazily off the hot path;
 *  the renderer holds a mirror for synchronous lookups. No IPC / Electron.
 *--------------------------------------------------------------------------------------------*/

import type { CancellationToken } from '../base/cancellation.js'
import { type IDisposable, toDisposable } from '../base/lifecycle.js'
import type { AiCurrency, AiModelPricing } from './aiModelPricing.js'

/** A remote-source declaration persisted on a provider type / instance. */
export interface AiRemoteSourceSpec {
  readonly id: string
  readonly options?: Readonly<Record<string, unknown>>
}

/** What a source implementation gets to work with. Never logged. */
export interface AiSourceFetchContext {
  readonly typeId: string
  readonly instanceName: string
  readonly baseUrl?: string
  readonly apiKey?: string
  readonly options?: Readonly<Record<string, unknown>>
}

/** bare model id → rate. */
export type AiRateTable = Readonly<Record<string, AiModelPricing>>

export interface IAiPricingSource {
  readonly id: string
  fetchRates(ctx: AiSourceFetchContext, token: CancellationToken): Promise<AiRateTable | undefined>
}

/** One rolling window of a subscription-style quota. */
export interface AiAccountUsageWindow {
  readonly id: string
  readonly label: string
  readonly usedPercent: number
  readonly resetsAt?: number
}

/** Authoritative account-level spend / quota. Absent means "unavailable", never estimated. */
export interface AiAccountUsage {
  readonly kind: 'quota' | 'balance' | 'subscription'
  readonly usedUSD?: number
  readonly limitUSD?: number
  readonly remainingUSD?: number
  readonly currency?: AiCurrency
  readonly windows?: readonly AiAccountUsageWindow[]
  readonly fetchedAt: number
}

export interface IAiAccountUsageSource {
  readonly id: string
  fetchUsage(
    ctx: AiSourceFetchContext,
    token: CancellationToken,
  ): Promise<AiAccountUsage | undefined>
}

export class AiRemoteSourceRegistry {
  private readonly _pricingSources = new Map<string, IAiPricingSource>()
  private readonly _usageSources = new Map<string, IAiAccountUsageSource>()

  registerPricingSource(source: IAiPricingSource): IDisposable {
    if (this._pricingSources.has(source.id)) {
      throw new Error(`AI pricing source '${source.id}' is already registered`)
    }
    this._pricingSources.set(source.id, source)
    return toDisposable(() => {
      if (this._pricingSources.get(source.id) !== source) return
      this._pricingSources.delete(source.id)
    })
  }

  registerUsageSource(source: IAiAccountUsageSource): IDisposable {
    if (this._usageSources.has(source.id)) {
      throw new Error(`AI account usage source '${source.id}' is already registered`)
    }
    this._usageSources.set(source.id, source)
    return toDisposable(() => {
      if (this._usageSources.get(source.id) !== source) return
      this._usageSources.delete(source.id)
    })
  }

  getPricingSource(id: string): IAiPricingSource | undefined {
    return this._pricingSources.get(id)
  }

  getUsageSource(id: string): IAiAccountUsageSource | undefined {
    return this._usageSources.get(id)
  }
}
