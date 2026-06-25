/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Fetches the USD→CNY exchange rate from a free public API and caches it under
 *  `<userData>/exchange-rate.json`. Mirrors RemoteSchemaMainService: a TTL skips
 *  the network for a day, and a stale-cache (or hardcoded constant) fallback keeps
 *  an offline launch usable.
 *--------------------------------------------------------------------------------------------*/

import { app } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import {
  Disposable,
  type ILogger,
  ILoggerService,
  createNamedLogger,
} from '@universe-editor/platform'
import type { ExchangeRateResult, IExchangeRateService } from '../../../shared/ipc/services.js'

interface CacheEntry {
  rate: number
  fetchedAt: number
}

interface ErApiResponse {
  result?: string
  rates?: Record<string, number>
}

/** Skip the network when the cached rate is younger than this. */
const TTL_MS = 24 * 60 * 60 * 1000
const RATE_URL = 'https://open.er-api.com/v6/latest/USD'
const FALLBACK_RATE = 7.2

export class ExchangeRateMainService extends Disposable implements IExchangeRateService {
  declare readonly _serviceBrand: undefined

  private readonly _logger: ILogger

  constructor(
    private readonly _cacheFile: string = join(app.getPath('userData'), 'exchange-rate.json'),
    @ILoggerService loggerService?: ILoggerService,
  ) {
    super()
    this._logger = createNamedLogger(loggerService, { id: 'exchangeRate', name: 'Exchange Rate' })
  }

  async getUsdToCnyRate(): Promise<ExchangeRateResult> {
    const cached = await this._readCache()
    if (cached && Date.now() - cached.fetchedAt < TTL_MS) {
      this._logger.trace(`serving fresh cached rate ${cached.rate} (fetchedAt ${cached.fetchedAt})`)
      return { rate: cached.rate, source: 'live', fetchedAt: cached.fetchedAt }
    }

    try {
      const res = await fetch(RATE_URL, { redirect: 'follow' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as ErApiResponse
      const rate = data.rates?.CNY
      if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
        throw new Error(`invalid CNY rate in response: ${String(rate)}`)
      }
      const fetchedAt = Date.now()
      this._logger.trace(`fetched USD→CNY rate ${rate}`)
      await this._writeCache({ rate, fetchedAt })
      return { rate, source: 'live', fetchedAt }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (cached) {
        this._logger.warn(
          `rate fetch failed (${message}); serving stale cached rate ${cached.rate}`,
        )
        return { rate: cached.rate, source: 'live', fetchedAt: cached.fetchedAt }
      }
      this._logger.warn(`rate fetch failed (${message}); falling back to ${FALLBACK_RATE}`)
      return { rate: FALLBACK_RATE, source: 'fallback', fetchedAt: Date.now() }
    }
  }

  private async _readCache(): Promise<CacheEntry | undefined> {
    try {
      const raw = await fs.readFile(this._cacheFile, 'utf8')
      return JSON.parse(raw) as CacheEntry
    } catch {
      return undefined
    }
  }

  private async _writeCache(entry: CacheEntry): Promise<void> {
    try {
      await fs.writeFile(this._cacheFile, JSON.stringify(entry), 'utf8')
    } catch (err) {
      this._logger.warn(`cache write failed: ${String(err)}`)
    }
  }
}
