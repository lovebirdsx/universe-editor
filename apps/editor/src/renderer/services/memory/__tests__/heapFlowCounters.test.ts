/*---------------------------------------------------------------------------------------------
 *  Tests for the renderer's between-samples counters.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it } from 'vitest'
import {
  addCodeHtmlBytes,
  bumpHeapFlow,
  drainHeapFlow,
  readCodeHtmlBytes,
  readHeapGauges,
  setHeapGauge,
} from '../heapFlowCounters.js'

const ALL_GAUGES = ['domnodes', 'astnodes', 'sealednodes', 'tailchars'] as const

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
    setHeapGauge('tailchars', 0)

    expect(readHeapGauges()).toEqual([{ name: 'domnodes', value: 120_000 }])
  })

  it('refuses a gauge that cannot be a count', () => {
    setHeapGauge('domnodes', Number.POSITIVE_INFINITY)
    setHeapGauge('domnodes', -1)

    expect(readHeapGauges()).toEqual([])
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
