/*---------------------------------------------------------------------------------------------
 *  Tests for packages/platform/src/base/observable/observables/derivedImpl.ts
 *  Covers observer hot-swap, dependency propagation, and the dev-mode cyclic-derived
 *  warning (the hard check stays disabled to match upstream).
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect, vi } from 'vitest'
import { observableValue, derived, transaction, autorun } from '../../../base/observable/index.js'

describe('derivedImpl — observers & propagation', () => {
  it('caches while observed and recomputes lazily without observers', () => {
    const base = observableValue('base', 1)
    let computes = 0
    const d = derived(undefined, (r) => {
      computes++
      return base.read(r) * 2
    })

    // No observers: every get recomputes (no caching, to avoid leaks).
    d.get()
    d.get()
    expect(computes).toBe(2)

    // Attach an observer: value is cached, compute only on dependency change.
    computes = 0
    const sub = autorun((r) => {
      d.read(r)
    })
    expect(computes).toBe(1)
    d.get() // cached, no recompute
    expect(computes).toBe(1)

    transaction((tx) => base.set(2, tx))
    expect(computes).toBe(2)
    expect(d.get()).toBe(4)
    sub.dispose()
  })

  it('propagates changes through chained deriveds', () => {
    const base = observableValue('base', 1)
    const plusOne = derived(undefined, (r) => base.read(r) + 1)
    const timesTen = derived(undefined, (r) => plusOne.read(r) * 10)
    const seen: number[] = []
    const sub = autorun((r) => {
      seen.push(timesTen.read(r))
    })
    expect(seen).toEqual([20])
    transaction((tx) => base.set(4, tx))
    expect(seen).toEqual([20, 50])
    sub.dispose()
  })
})

describe('derivedImpl — cyclic derived warning', () => {
  it('warns (dev) but does not throw when a derived reads itself during compute', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    let entered = 0
    const self: ReturnType<typeof derived<number>> = derived(undefined, (): number => {
      entered++
      if (entered === 1) {
        // Re-enter our own computation while it is in progress → cyclic.
        // Reachable only on the observed (cached) path, where `_isComputing` is set.
        return self.get() + 1
      }
      return 0
    })

    // Subscribing routes through `_recompute`, which sets `_isComputing`.
    let threw = false
    let sub: { dispose(): void } | undefined
    try {
      sub = autorun((r) => {
        self.read(r)
      })
    } catch {
      threw = true
    }
    expect(threw).toBe(false)
    expect(warn).toHaveBeenCalled()
    expect(warn.mock.calls[0]?.[0]).toContain('cyclic derived')
    sub?.dispose()
    warn.mockRestore()
  })

  it('warns at most once per derived instance across recomputes', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const dep = observableValue('dep', 0)

    let depth = 0
    const self: ReturnType<typeof derived<number>> = derived(undefined, (r): number => {
      dep.read(r)
      depth++
      if (depth === 1 || depth === 3) {
        return self.get() + 1 // re-enter on the first compute of each recompute
      }
      return 0
    })
    const sub = autorun((r) => {
      self.read(r)
    })
    transaction((tx) => dep.set(1, tx)) // force a second recompute
    // WeakSet de-dups: at most one warning for this instance.
    expect(warn.mock.calls.length).toBeLessThanOrEqual(1)
    sub.dispose()
    warn.mockRestore()
  })
})
