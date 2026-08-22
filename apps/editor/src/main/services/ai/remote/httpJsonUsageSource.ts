/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  http-json account usage source: fetches a gateway self endpoint (one-api /
 *  new-api style) and normalizes used / limit / remaining into an
 *  AiAccountUsage snapshot. Failures return undefined and never throw.
 *--------------------------------------------------------------------------------------------*/

import {
  NullLogger,
  type AiAccountUsage,
  type AiSourceFetchContext,
  type CancellationToken,
  type IAiAccountUsageSource,
  type ILogger,
} from '@universe-editor/platform'
import {
  parseAccountUsage,
  readAccountUsageOptions,
} from '../../../../shared/ai/parseRemoteJson.js'
import { buildHeaders, fetchJson, hostOf, readHttpJsonOptions, resolveUrl } from './httpJson.js'

const DEFAULT_PATH = '/api/user/self'
const REQUEST_TIMEOUT_MS = 10_000

export class HttpJsonUsageSource implements IAiAccountUsageSource {
  readonly id = 'http-json'

  private readonly _logger: ILogger

  constructor(logger?: ILogger) {
    this._logger = logger ?? new NullLogger()
  }

  async fetchUsage(
    ctx: AiSourceFetchContext,
    token: CancellationToken,
  ): Promise<AiAccountUsage | undefined> {
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
        this._logger.warn(`ai remote usage: request failed for ${hostOf(url)}`)
      }
      return undefined
    }

    const usage = parseAccountUsage(json, readAccountUsageOptions(ctx.options), Date.now())
    if (usage === undefined) {
      this._logger.warn(`ai remote usage: no usable numbers from ${hostOf(url)}`)
      return undefined
    }
    this._logger.info(`ai remote usage: ${usage.kind} snapshot from ${hostOf(url)}`)
    return usage
  }
}
