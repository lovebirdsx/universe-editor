/*---------------------------------------------------------------------------------------------
 *  Tests for packages/platform/src/ai/aiRemoteSources.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { AiRemoteSourceRegistry } from '../../ai/aiRemoteSources.js'
import type { IAiAccountUsageSource, IAiPricingSource } from '../../ai/aiRemoteSources.js'

function pricingSource(id: string): IAiPricingSource {
  return { id, fetchRates: () => Promise.resolve(undefined) }
}

function usageSource(id: string): IAiAccountUsageSource {
  return { id, fetchUsage: () => Promise.resolve(undefined) }
}

describe('AiRemoteSourceRegistry', () => {
  it('registers and returns pricing sources, and removes them on dispose', () => {
    const reg = new AiRemoteSourceRegistry()
    const s = pricingSource('catalog')
    const d = reg.registerPricingSource(s)
    expect(reg.getPricingSource('catalog')).toBe(s)
    expect(reg.getPricingSource('missing')).toBeUndefined()
    d.dispose()
    expect(reg.getPricingSource('catalog')).toBeUndefined()
  })

  it('registers and returns usage sources', () => {
    const reg = new AiRemoteSourceRegistry()
    const s = usageSource('subscription')
    reg.registerUsageSource(s)
    expect(reg.getUsageSource('subscription')).toBe(s)
    expect(reg.getUsageSource('missing')).toBeUndefined()
  })

  it('rejects duplicate pricing source ids', () => {
    const reg = new AiRemoteSourceRegistry()
    reg.registerPricingSource(pricingSource('dup'))
    expect(() => reg.registerPricingSource(pricingSource('dup'))).toThrow(/already registered/)
  })

  it('rejects duplicate usage source ids', () => {
    const reg = new AiRemoteSourceRegistry()
    reg.registerUsageSource(usageSource('dup'))
    expect(() => reg.registerUsageSource(usageSource('dup'))).toThrow(/already registered/)
  })

  it('keeps pricing and usage namespaces separate', () => {
    const reg = new AiRemoteSourceRegistry()
    reg.registerPricingSource(pricingSource('shared'))
    reg.registerUsageSource(usageSource('shared'))
    expect(reg.getPricingSource('shared')).toBeDefined()
    expect(reg.getUsageSource('shared')).toBeDefined()
  })
})
