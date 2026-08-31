import { afterEach, describe, expect, it } from 'vitest'
import {
  GLOBAL_PERFORCE_GRAPH_KEY,
  _resetForTests,
  getPerforceGraphViewState,
  perforceGraphViewState,
} from '../perforceGraphViewState.js'

describe('perforceGraphViewState', () => {
  afterEach(() => {
    _resetForTests()
  })

  it('isolates buckets per key', () => {
    const a = getPerforceGraphViewState('universe:/perforceGraph?A')
    const b = getPerforceGraphViewState('universe:/perforceGraph?B')
    expect(a).not.toBe(b)
    a.selection = ['1']
    expect(b.selection).toEqual([])
  })

  it('reuses the same bucket for the same key', () => {
    const first = getPerforceGraphViewState('universe:/perforceGraph?A')
    const second = getPerforceGraphViewState('universe:/perforceGraph?A')
    expect(second).toBe(first)
  })

  it('never evicts the GLOBAL bucket', () => {
    const global = getPerforceGraphViewState(GLOBAL_PERFORCE_GRAPH_KEY)
    expect(global).toBe(perforceGraphViewState)
    for (let i = 0; i < 20; i++) {
      getPerforceGraphViewState(`scoped-${i}`)
    }
    expect(getPerforceGraphViewState(GLOBAL_PERFORCE_GRAPH_KEY)).toBe(perforceGraphViewState)
  })

  it('evicts the least-recently-accessed scoped bucket beyond the cap and re-fetches a fresh one', () => {
    const evicted = getPerforceGraphViewState('scoped-a')
    evicted.selection = ['stale']
    // 12 more insertions overflow the cap (12). 'scoped-a' was never re-accessed,
    // so it is the least-recently-accessed bucket and gets evicted.
    for (let i = 0; i < 12; i++) {
      getPerforceGraphViewState(`scoped-b-${i}`)
    }
    const refetched = getPerforceGraphViewState('scoped-a')
    expect(refetched).not.toBe(evicted)
    expect(refetched.selection).toEqual([])
  })

  it('re-accessing a bucket refreshes its recency so it survives eviction', () => {
    const kept = getPerforceGraphViewState('scoped-keep')
    for (let i = 0; i < 11; i++) {
      getPerforceGraphViewState(`scoped-fill-${i}`)
    }
    // Touch the oldest bucket so it becomes the most-recently-accessed, then
    // overflow: the true least-recently-accessed bucket goes, not `kept`.
    getPerforceGraphViewState('scoped-keep')
    getPerforceGraphViewState('scoped-overflow')
    expect(getPerforceGraphViewState('scoped-keep')).toBe(kept)
  })
})
