/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  On-disk cache for remote AI rate tables and account usage, keyed by provider
 *  id. Pure storage with a dual TTL; it never touches the network and never
 *  throws — a missing / corrupt / wrong-version file is simply treated as empty
 *  (a v1 file, keyed by the retired `type/instance`, is discarded: rates re-pull
 *  within the 24h TTL and are not worth migrating). Writes are debounced and
 *  atomic (temp + rename).
 *--------------------------------------------------------------------------------------------*/

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  NullLogger,
  type AiAccountUsage,
  type AiAccountUsageWindow,
  type AiModelPricing,
  type AiRateTable,
  type ILogger,
} from '@universe-editor/platform'
import { toFiniteNumber } from '../../../../shared/ai/parseRemoteJson.js'
import { RATES_TTL_MS, USAGE_TTL_MS } from '../../../../shared/ai/aiRemoteTtls.js'

export { RATES_TTL_MS, USAGE_TTL_MS }

const FILE_NAME = 'aiRemoteCache.json'
const FLUSH_DEBOUNCE_MS = 200

export interface CachedRates {
  readonly fetchedAt: number
  readonly rates: AiRateTable
}

/** On-disk shape. Keyed by provider id. */
interface AiRemoteCacheFile {
  readonly version: 2
  readonly rates?: Readonly<Record<string, CachedRates>>
  readonly usage?: Readonly<Record<string, AiAccountUsage>>
}

export class AiRemoteCache {
  private readonly _logger: ILogger
  private readonly _rates = new Map<string, CachedRates>()
  private readonly _usage = new Map<string, AiAccountUsage>()
  private _loaded = false
  private _loadPromise: Promise<void> | undefined
  private _flushTimer: ReturnType<typeof setTimeout> | undefined
  private _flushPromise: Promise<void> | undefined

  constructor(
    private readonly _dir: () => Promise<string>,
    logger?: ILogger,
  ) {
    this._logger = logger ?? new NullLogger()
  }

  /** Load from disk once; subsequent calls are cheap. Never throws. */
  load(): Promise<void> {
    if (this._loaded) return Promise.resolve()
    if (this._loadPromise === undefined) {
      this._loadPromise = this._loadInternal().finally(() => {
        this._loaded = true
      })
    }
    return this._loadPromise
  }

  getRates(providerId: string): CachedRates | undefined {
    return this._rates.get(providerId)
  }

  getUsage(providerId: string): AiAccountUsage | undefined {
    return this._usage.get(providerId)
  }

  /** Every cached rate table, for the renderer's synchronous mirror. */
  allRates(): readonly {
    readonly providerId: string
    readonly rates: AiRateTable
    readonly fetchedAt: number
  }[] {
    return [...this._rates.entries()].map(([providerId, cached]) => ({
      providerId,
      rates: cached.rates,
      fetchedAt: cached.fetchedAt,
    }))
  }

  setRates(providerId: string, rates: AiRateTable, fetchedAt?: number): void {
    this._rates.set(providerId, { fetchedAt: fetchedAt ?? Date.now(), rates })
  }

  setUsage(providerId: string, usage: AiAccountUsage): void {
    this._usage.set(providerId, usage)
  }

  /** Drop entries whose provider no longer exists, so the file cannot grow forever. */
  prune(liveProviderIds: readonly string[]): void {
    const live = new Set(liveProviderIds)
    for (const key of this._rates.keys()) {
      if (!live.has(key)) this._rates.delete(key)
    }
    for (const key of this._usage.keys()) {
      if (!live.has(key)) this._usage.delete(key)
    }
  }

  isRatesStale(providerId: string, now?: number): boolean {
    const cached = this._rates.get(providerId)
    if (cached === undefined) return true
    return (now ?? Date.now()) - cached.fetchedAt >= RATES_TTL_MS
  }

  isUsageStale(providerId: string, now?: number): boolean {
    const cached = this._usage.get(providerId)
    if (cached === undefined) return true
    return (now ?? Date.now()) - cached.fetchedAt >= USAGE_TTL_MS
  }

  /** Debounced atomic write (temp + rename). Never throws. */
  flush(): Promise<void> {
    if (this._flushPromise !== undefined) return this._flushPromise
    this._flushPromise = new Promise<void>((resolve) => {
      this._flushTimer = setTimeout(() => {
        this._flushTimer = undefined
        void this._write().finally(() => {
          this._flushPromise = undefined
          resolve()
        })
      }, FLUSH_DEBOUNCE_MS)
    })
    return this._flushPromise
  }

  private async _loadInternal(): Promise<void> {
    let dir: string
    try {
      dir = await this._dir()
    } catch {
      return
    }
    let text: string
    try {
      text = await readFile(join(dir, FILE_NAME), 'utf8')
    } catch {
      return
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      this._logger.warn('ai remote cache: ignoring corrupt cache file')
      return
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return
    const file = parsed as Record<string, unknown>
    if (file.version !== 2) return

    const rates = file.rates
    if (rates !== null && typeof rates === 'object' && !Array.isArray(rates)) {
      for (const [key, value] of Object.entries(rates as Record<string, unknown>)) {
        const cached = reviveCachedRates(value)
        if (cached !== undefined) this._rates.set(key, cached)
      }
    }
    const usage = file.usage
    if (usage !== null && typeof usage === 'object' && !Array.isArray(usage)) {
      for (const [key, value] of Object.entries(usage as Record<string, unknown>)) {
        const revived = reviveUsage(value)
        if (revived !== undefined) this._usage.set(key, revived)
      }
    }
  }

  private async _write(): Promise<void> {
    let dir: string
    try {
      dir = await this._dir()
    } catch {
      return
    }
    const file: AiRemoteCacheFile = {
      version: 2,
      ...(this._rates.size > 0 ? { rates: Object.fromEntries(this._rates) } : {}),
      ...(this._usage.size > 0 ? { usage: Object.fromEntries(this._usage) } : {}),
    }
    try {
      await mkdir(dir, { recursive: true })
      const path = join(dir, FILE_NAME)
      const tmp = `${path}.${process.pid}.tmp`
      await writeFile(tmp, JSON.stringify(file, null, 2) + '\n', 'utf8')
      await rename(tmp, path)
    } catch (err) {
      this._logger.warn(
        `ai remote cache: write failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
}

function reviveCachedRates(value: unknown): CachedRates | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const obj = value as Record<string, unknown>
  const fetchedAt = toFiniteNumber(obj.fetchedAt)
  if (fetchedAt === undefined) return undefined
  const ratesRaw = obj.rates
  if (ratesRaw === null || typeof ratesRaw !== 'object' || Array.isArray(ratesRaw)) return undefined
  const rates: Record<string, AiModelPricing> = {}
  for (const [id, entry] of Object.entries(ratesRaw as Record<string, unknown>)) {
    const pricing = revivePricing(entry)
    if (pricing !== undefined) rates[id] = pricing
  }
  return { fetchedAt, rates }
}

function revivePricing(value: unknown): AiModelPricing | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const obj = value as Record<string, unknown>
  const input = toFiniteNumber(obj.input)
  const output = toFiniteNumber(obj.output)
  if (input === undefined || output === undefined) return undefined
  const cacheRead = toFiniteNumber(obj.cacheRead)
  const cacheWrite = toFiniteNumber(obj.cacheWrite)
  const currency = obj.currency === 'USD' || obj.currency === 'CNY' ? obj.currency : undefined
  return {
    input,
    output,
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
    ...(currency !== undefined ? { currency } : {}),
  }
}

function reviveUsage(value: unknown): AiAccountUsage | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const obj = value as Record<string, unknown>
  const kind = obj.kind
  if (kind !== 'quota' && kind !== 'balance' && kind !== 'subscription') return undefined
  const fetchedAt = toFiniteNumber(obj.fetchedAt)
  if (fetchedAt === undefined) return undefined
  const usedUSD = toFiniteNumber(obj.usedUSD)
  const limitUSD = toFiniteNumber(obj.limitUSD)
  const remainingUSD = toFiniteNumber(obj.remainingUSD)
  const currency = obj.currency === 'USD' || obj.currency === 'CNY' ? obj.currency : undefined
  const windows = Array.isArray(obj.windows)
    ? (obj.windows as readonly AiAccountUsageWindow[])
    : undefined
  return {
    kind,
    fetchedAt,
    ...(usedUSD !== undefined ? { usedUSD } : {}),
    ...(limitUSD !== undefined ? { limitUSD } : {}),
    ...(remainingUSD !== undefined ? { remainingUSD } : {}),
    ...(currency !== undefined ? { currency } : {}),
    ...(windows !== undefined ? { windows } : {}),
  }
}
