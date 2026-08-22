/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Pricing / token-tally model and cost estimation for AI model usage. Rates are
 *  per-1M-token, unified across Claude and Codex so the UI can compare spend
 *  across providers without knowing vendor specifics.
 *--------------------------------------------------------------------------------------------*/

export type AiCurrency = 'USD' | 'CNY'

/** Per-1M-token rates. Missing cacheWrite is billed at the input rate. */
export interface AiModelPricing {
  /** Defaults to USD when absent. */
  readonly currency?: AiCurrency
  readonly input: number
  readonly output: number
  readonly cacheRead?: number
  readonly cacheWrite?: number
}

/** Token counts for one turn / session, unified across Claude(4 档) and Codex(3 档). */
export interface AiTokenTally {
  readonly input: number
  readonly output: number
  readonly cacheRead?: number
  readonly cacheWrite?: number
}

/** Which level of the resolution chain produced a rate. */
export type AiPricingOrigin = 'model' | 'gateway' | 'type' | 'catalog'

export const CNY_PER_USD = 7.2

/** Cost in USD across the four buckets. CNY rates are normalized to USD. */
export function estimateCostUSD(pricing: AiModelPricing, tally: AiTokenTally): number {
  const input = pricing.input
  const cacheRead = pricing.cacheRead ?? input
  const cacheWrite = pricing.cacheWrite ?? input
  const usd =
    (tally.input * input +
      tally.output * pricing.output +
      (tally.cacheRead ?? 0) * cacheRead +
      (tally.cacheWrite ?? 0) * cacheWrite) /
    1e6
  return pricing.currency === 'CNY' ? usd / CNY_PER_USD : usd
}

/** Field-by-field equality, used to detect whether the user overrode a default rate. */
export function isSamePricing(
  a: AiModelPricing | undefined,
  b: AiModelPricing | undefined,
): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined) return false
  return (
    (a.currency ?? 'USD') === (b.currency ?? 'USD') &&
    a.input === b.input &&
    a.output === b.output &&
    (a.cacheRead ?? a.input) === (b.cacheRead ?? b.input) &&
    (a.cacheWrite ?? a.input) === (b.cacheWrite ?? b.input)
  )
}
