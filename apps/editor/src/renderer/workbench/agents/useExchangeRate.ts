import { useEffect, useState } from 'react'
import { useOptionalService } from '../useService.js'
import { IExchangeRateService, type ExchangeRateResult } from '../../../shared/ipc/services.js'
import { usdToCnyRate } from '../../services/usage/usdToCnyRate.js'

/**
 * USD→CNY rate for cost display. The memoized promise is shared with the pricing
 * side (which divides CNY rates *by* it) so both directions agree — see
 * `services/usage/usdToCnyRate.ts`.
 */
export function useUsdToCnyRate(): ExchangeRateResult | undefined {
  const service = useOptionalService(IExchangeRateService)
  const [rate, setRate] = useState<ExchangeRateResult | undefined>(undefined)

  useEffect(() => {
    if (!service) return
    let alive = true
    usdToCnyRate(service).then(
      (r) => {
        if (alive) setRate(r)
      },
      () => {
        // Swallow: the main service already falls back to a constant, so a
        // rejection here is unexpected. Leave rate undefined → caller shows USD.
      },
    )
    return () => {
      alive = false
    }
  }, [service])

  return rate
}
