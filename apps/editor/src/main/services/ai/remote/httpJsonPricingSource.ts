/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  http-json pricing source: fetches a gateway price list (one-api / new-api /
 *  LiteLLM / OpenRouter style JSON) and normalizes it into an AiRateTable.
 *  Failures — missing baseUrl, non-2xx, bad JSON, an empty table — return
 *  undefined and never throw, so the coordinator keeps any prior cache.
 *--------------------------------------------------------------------------------------------*/

import {
  NullLogger,
  type AiRateTable,
  type AiSourceFetchContext,
  type CancellationToken,
  type IAiPricingSource,
  type ILogger,
} from '@universe-editor/platform'
import { parseRateTable, readRateTableOptions } from '../../../../shared/ai/parseRemoteJson.js'
import { buildHeaders, fetchJson, hostOf, readHttpJsonOptions, resolveUrl } from './httpJson.js'

const DEFAULT_PATH = '/v1/pricing'
const REQUEST_TIMEOUT_MS = 10_000

export class HttpJsonPricingSource implements IAiPricingSource {
  readonly id = 'http-json'

  private readonly _logger: ILogger

  constructor(logger?: ILogger) {
    this._logger = logger ?? new NullLogger()
  }

  async fetchRates(
    ctx: AiSourceFetchContext,
    token: CancellationToken,
  ): Promise<AiRateTable | undefined> {
    const http = readHttpJsonOptions(ctx.options)
    const url = resolveUrl(ctx, http, DEFAULT_PATH)
    if (url === undefined) return undefined

    const json = await fetchJson(
      url,
      { headers: buildHeaders(ctx, http) },
      token,
      REQUEST_TIMEOUT_MS,
    )
    if (json === undefined) {
      if (!token.isCancellationRequested) {
        this._logger.warn(`ai remote pricing: request failed for ${hostOf(url)}`)
      }
      return undefined
    }

    const rates = parseRateTable(json, readRateTableOptions(ctx.options))
    if (Object.keys(rates).length === 0) {
      this._logger.warn(`ai remote pricing: empty rate table for ${hostOf(url)}`)
      return undefined
    }
    this._logger.info(`ai remote pricing: ${Object.keys(rates).length} rates from ${hostOf(url)}`)
    return rates
  }
}
