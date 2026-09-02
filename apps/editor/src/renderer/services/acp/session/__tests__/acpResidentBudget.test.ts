/*---------------------------------------------------------------------------------------------
 *  Cross-session resident budget. Per-session budgets alone let a window with
 *  several resumed sessions multiply the ceiling by the number of sessions —
 *  which is how the renderer filled the V8 pointer cage. The shared budget sums
 *  every holder and releases from the least-recently-ingesting one first.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { AcpResidentBudget, type IAcpResidentBudgetHolder } from '../acpResidentBudget.js'

/** A holder whose content is a plain byte count it can shed on demand. */
function fakeHolder(budgetId: string, bytes: number, lastIngestAt: number) {
  const state = { bytes, lastIngestAt, trimCalls: 0 }
  const holder: IAcpResidentBudgetHolder = {
    budgetId,
    residentBytes: () => state.bytes,
    lastIngestAt: () => state.lastIngestAt,
    trimToward: (target) => {
      state.trimCalls++
      const freed = Math.max(0, state.bytes - target)
      state.bytes -= freed
      return freed
    },
  }
  return { holder, state }
}

describe('AcpResidentBudget', () => {
  it('leaves everyone alone while the total is under budget', () => {
    const budget = new AcpResidentBudget(1000)
    const a = fakeHolder('a', 300, 1)
    const b = fakeHolder('b', 300, 2)
    budget.register(a.holder)
    budget.register(b.holder)

    budget.reconcile('test')

    expect(budget.totalBytes()).toBe(600)
    expect(a.state.trimCalls).toBe(0)
    expect(b.state.trimCalls).toBe(0)
  })

  it('releases from the oldest-ingesting holder first and stops once under', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const budget = new AcpResidentBudget(1000)
    const stale = fakeHolder('stale', 600, 1)
    const active = fakeHolder('active', 600, 99)
    budget.register(stale.holder)
    budget.register(active.holder)

    budget.reconcile('test')

    // 1200 total, 200 over: the stale holder gives up exactly the excess and
    // the foreground one is never asked.
    expect(stale.state.bytes).toBe(400)
    expect(active.state.bytes).toBe(600)
    expect(active.state.trimCalls).toBe(0)
    expect(budget.totalBytes()).toBe(1000)
  })

  it('moves on to the next holder when the oldest has nothing left to give', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const budget = new AcpResidentBudget(500)
    const empty = fakeHolder('empty', 0, 1)
    const stale = fakeHolder('stale', 400, 2)
    const active = fakeHolder('active', 400, 3)
    budget.register(empty.holder)
    budget.register(stale.holder)
    budget.register(active.holder)

    budget.reconcile('test')

    expect(empty.state.bytes).toBe(0)
    expect(stale.state.bytes).toBe(100)
    expect(active.state.bytes).toBe(400)
    expect(budget.totalBytes()).toBe(500)
  })

  it('stops accounting for a holder once its registration is disposed', () => {
    const budget = new AcpResidentBudget(1000)
    const a = fakeHolder('a', 900, 1)
    const registration = budget.register(a.holder)
    expect(budget.totalBytes()).toBe(900)

    registration.dispose()

    expect(budget.totalBytes()).toBe(0)
    budget.reconcile('test')
    expect(a.state.trimCalls).toBe(0)
  })

  it('ignores a reconcile re-entered from inside a trim', () => {
    // A real holder pushes observables while trimming, which can loop back here
    // — a nested pass would double-count the release in progress.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const budget = new AcpResidentBudget(100)
    let nestedTrimCalls = 0
    const other = fakeHolder('other', 200, 99)
    const reentrant: IAcpResidentBudgetHolder = {
      budgetId: 'reentrant',
      residentBytes: () => 200,
      lastIngestAt: () => 1,
      trimToward: () => {
        budget.reconcile('nested')
        nestedTrimCalls++
        return 0
      },
    }
    budget.register(reentrant)
    budget.register(other.holder)

    budget.reconcile('outer')

    expect(nestedTrimCalls).toBe(1)
    // The nested call was a no-op, so the outer pass still reached `other`.
    expect(other.state.trimCalls).toBe(1)
  })
})
