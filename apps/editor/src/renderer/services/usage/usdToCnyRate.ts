/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  One window-wide USD→CNY rate, shared by the two directions of the cost path.
 *
 *  Cost estimation normalizes a CNY-priced gateway rate *into* USD and the cost
 *  indicators convert that USD *back* to CNY. Both must divide and multiply by
 *  the same number or the displayed figure skews by their ratio, so the promise
 *  is memoized here rather than per consumer: the main service owns the 24h disk
 *  cache, this only collapses the round-trip.
 *--------------------------------------------------------------------------------------------*/

import type { ExchangeRateResult, IExchangeRateService } from '../../../shared/ipc/services.js'

let inFlight: Promise<ExchangeRateResult> | undefined

/**
 * The shared rate promise. Rejections clear the memo so a later caller retries —
 * the main service falls back to a constant and never rejects in practice.
 */
export function usdToCnyRate(service: IExchangeRateService): Promise<ExchangeRateResult> {
  if (inFlight === undefined) {
    inFlight = service.getUsdToCnyRate()
    inFlight.catch(() => {
      inFlight = undefined
    })
  }
  return inFlight
}
