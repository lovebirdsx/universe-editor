/*---------------------------------------------------------------------------------------------
 *  Tests for the renderer's between-samples counters.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  addCodeHtmlBytes,
  bumpHeapFlow,
  drainHeapFlow,
  readCodeHtmlBytes,
  readHeapFlowTotals,
  readHeapGauges,
  registerHeapView,
  setHeapGauge,
  unregisterHeapView,
  type HeapViewGauges,
} from '../heapFlowCounters.js'

const ALL_GAUGES = ['domnodes'] as const

/** Totals never reset, so a reading is only meaningful against an earlier one. */
const callsSince = (baseline: readonly { name: string; calls: number }[], name: string): number => {
  const before = baseline.find((f) => f.name === name)?.calls ?? 0
  const now = readHeapFlowTotals().find((f) => f.name === name)?.calls ?? 0
  return now - before
}

describe('heap flow counters', () => {
  beforeEach(() => {
    drainHeapFlow()
    for (const name of ALL_GAUGES) setHeapGauge(name, 0)
  })

  it('accumulates calls and characters per name', () => {
    bumpHeapFlow('mdparse', 100)
    bumpHeapFlow('mdparse', 50)
    bumpHeapFlow('colorize', 7)

    expect(drainHeapFlow()).toEqual([
      { name: 'mdparse', calls: 2, chars: 150 },
      { name: 'colorize', calls: 1, chars: 7 },
    ])
  })

  it('resets on drain so every reading covers its own interval', () => {
    bumpHeapFlow('mdreseal', 10)
    drainHeapFlow()

    expect(drainHeapFlow()).toEqual([])
  })

  it('omits names that saw no activity', () => {
    bumpHeapFlow('materialize', 5)

    expect(drainHeapFlow().map((f) => f.name)).toEqual(['materialize'])
  })

  it('counts a call it cannot size without inventing characters', () => {
    bumpHeapFlow('colorize', Number.NaN)
    bumpHeapFlow('colorize', -5)

    expect(drainHeapFlow()).toEqual([{ name: 'colorize', calls: 2, chars: 0 }])
  })

  it('reports a gauge that was set and omits a zero reading', () => {
    setHeapGauge('domnodes', 120_000)

    expect(readHeapGauges()).toEqual([{ name: 'domnodes', value: 120_000 }])
  })

  it('refuses a gauge that cannot be a count', () => {
    setHeapGauge('domnodes', Number.POSITIVE_INFINITY)
    setHeapGauge('domnodes', -1)

    expect(readHeapGauges()).toEqual([])
  })
})

describe('mounted view gauges', () => {
  const registered: number[] = []

  afterEach(() => {
    while (registered.length > 0) unregisterHeapView(registered.pop()!)
  })

  const mount = (gauges: HeapViewGauges): number => {
    const id = registerHeapView(gauges)
    registered.push(id)
    return id
  }

  /**
   * The reason this replaced the last-writer-wins gauge: several chat panels are
   * mounted at once, and the reading exists to answer "how much markdown is this
   * window carrying" — reporting the view that happened to render last answers it
   * with one panel's worth no matter how many are holding content.
   */
  it('sums every mounted view rather than reporting the last one to render', () => {
    mount({ astnodes: 10, sealednodes: 8, tailchars: 100, mdbytes: 4000 })
    mount({ astnodes: 30, sealednodes: 30, tailchars: 5, mdbytes: 900 })

    expect(readHeapGauges()).toEqual([
      { name: 'views', value: 2 },
      { name: 'astnodes', value: 40 },
      { name: 'sealednodes', value: 38 },
      { name: 'tailchars', value: 105 },
      { name: 'mdbytes', value: 4900 },
    ])
  })

  it('follows a re-rendering view under a fresh handle, and drops one that unmounts', () => {
    const first = mount({ astnodes: 10, sealednodes: 10, tailchars: 0, mdbytes: 500 })
    // What MarkdownView actually does when the tail grows: the memoised gauges object
    // is new, so the effect tears the old handle down and registers a fresh one. The
    // reading has to follow it without the handle count creeping up.
    unregisterHeapView(first)
    const second = mount({ astnodes: 12, sealednodes: 12, tailchars: 3, mdbytes: 503 })

    expect(readHeapGauges()).toEqual([
      { name: 'views', value: 1 },
      { name: 'astnodes', value: 12 },
      { name: 'sealednodes', value: 12 },
      { name: 'tailchars', value: 3 },
      { name: 'mdbytes', value: 503 },
    ])

    unregisterHeapView(second)
    expect(readHeapGauges()).toEqual([])
  })
})

describe('process totals', () => {
  /**
   * The reason the totals exist. `drainHeapFlow` is destructive and the heap sampler
   * calls it every 5 seconds; a second observer sharing that counter loses whatever a
   * sample took first. That is what made the streaming e2e spec report `mdparse.calls: 1`
   * on a contended runner while passing locally, so it is worth a test rather than a
   * comment.
   */
  it('survives a drain by another observer', () => {
    const baseline = readHeapFlowTotals()

    bumpHeapFlow('mdparse', 100)
    drainHeapFlow() // the sampler samples mid-stream
    bumpHeapFlow('mdparse', 50)

    expect(callsSince(baseline, 'mdparse')).toBe(2)
    expect(drainHeapFlow()).toEqual([{ name: 'mdparse', calls: 1, chars: 50 }])
  })

  it('is not itself destructive', () => {
    const baseline = readHeapFlowTotals()

    bumpHeapFlow('colorize', 8)
    readHeapFlowTotals()

    expect(callsSince(baseline, 'colorize')).toBe(1)
  })
})

describe('code HTML accounting', () => {
  it('follows a replacement down and never goes below zero', () => {
    addCodeHtmlBytes(1000)
    expect(readCodeHtmlBytes()).toBe(1000)

    addCodeHtmlBytes(-400)
    expect(readCodeHtmlBytes()).toBe(600)

    addCodeHtmlBytes(-10_000)
    expect(readCodeHtmlBytes()).toBe(0)
  })

  it('ignores a delta that is not a number', () => {
    addCodeHtmlBytes(Number.NaN)

    expect(readCodeHtmlBytes()).toBe(0)
  })
})
