/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Catalog pricing source: a synchronous lookup into the built-in official rate
 *  tables, keyed by vendor. It makes no network request, so it is marked `sync`
 *  and must never be cached by the coordinator.
 *--------------------------------------------------------------------------------------------*/

import {
  NullLogger,
  type AiRateTable,
  type AiSourceFetchContext,
  type CancellationToken,
  type IAiPricingSource,
  type ILogger,
} from '@universe-editor/platform'
import {
  OFFICIAL_CATALOGS,
  readCatalogVendor,
} from '../../../../shared/ai/catalog/modelKnowledge.js'

export class CatalogPricingSource implements IAiPricingSource {
  readonly id = 'catalog'
  readonly sync = true

  private readonly _logger: ILogger

  constructor(logger?: ILogger) {
    this._logger = logger ?? new NullLogger()
  }

  async fetchRates(
    ctx: AiSourceFetchContext,
    _token: CancellationToken,
  ): Promise<AiRateTable | undefined> {
    const vendor = readCatalogVendor(ctx.options)
    if (vendor === undefined) {
      this._logger.warn('ai remote pricing: catalog source needs a vendor option')
      return undefined
    }
    return OFFICIAL_CATALOGS[vendor]
  }
}
