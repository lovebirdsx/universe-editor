import { useEffect, useState } from 'react'
import { useOptionalService } from '../useService.js'
import { IExchangeRateService, type ExchangeRateResult } from '../../../shared/ipc/services.js'

/**
 * USD→CNY rate for cost display. The main service owns the 24h disk cache and
 * network fetch; the renderer just memoizes the in-flight promise so every
 * indicator across the window shares a single round-trip per session.
 */
let cached: Promise<ExchangeRateResult> | undefined

export function useUsdToCnyRate(): ExchangeRateResult | undefined {
  const service = useOptionalService(IExchangeRateService)
  const [rate, setRate] = useState<ExchangeRateResult | undefined>(undefined)

  useEffect(() => {
    if (!service) return
    let alive = true
    if (cached === undefined) cached = service.getUsdToCnyRate()
    cached.then(
      (r) => {
        if (alive) setRate(r)
      },
      () => {
        // Swallow: the main service already falls back to a constant, so a
        // rejection here is unexpected. Leave rate undefined → caller shows USD.
        cached = undefined
      },
    )
    return () => {
      alive = false
    }
  }, [service])

  return rate
}
