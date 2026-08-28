/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EditAggregator, type EditAggregatorFlush } from '../editAggregator.js'

describe('EditAggregator', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('collapses repeated edits on one resource into a single count', () => {
    const seen: EditAggregatorFlush[][] = []
    const aggregator = new EditAggregator((edits) => seen.push([...edits]), 100)

    for (let i = 0; i < 12; i++) aggregator.record('file:///a.ts')
    expect(seen).toHaveLength(0)

    vi.advanceTimersByTime(100)
    expect(seen).toEqual([[{ resource: 'file:///a.ts', count: 12 }]])
  })

  it('keeps one entry per resource in the same flush', () => {
    const seen: EditAggregatorFlush[][] = []
    const aggregator = new EditAggregator((edits) => seen.push([...edits]), 100)

    aggregator.record('file:///a.ts')
    aggregator.record('file:///b.ts')
    aggregator.record('file:///a.ts')
    vi.advanceTimersByTime(100)

    expect(seen[0]).toEqual([
      { resource: 'file:///a.ts', count: 2 },
      { resource: 'file:///b.ts', count: 1 },
    ])
  })

  it('debounce is sliding — a new edit postpones the flush', () => {
    const seen: EditAggregatorFlush[][] = []
    const aggregator = new EditAggregator((edits) => seen.push([...edits]), 100)

    aggregator.record('file:///a.ts')
    vi.advanceTimersByTime(90)
    aggregator.record('file:///a.ts')
    vi.advanceTimersByTime(90)
    expect(seen).toHaveLength(0)

    vi.advanceTimersByTime(10)
    expect(seen).toEqual([[{ resource: 'file:///a.ts', count: 2 }]])
  })

  it('flush() emits immediately and cancels the pending timer', () => {
    const seen: EditAggregatorFlush[][] = []
    const aggregator = new EditAggregator((edits) => seen.push([...edits]), 100)

    aggregator.record('file:///a.ts')
    aggregator.flush()
    expect(seen).toHaveLength(1)

    vi.advanceTimersByTime(1000)
    expect(seen).toHaveLength(1)
  })

  it('flush() with nothing pending does not emit an empty batch', () => {
    const seen: EditAggregatorFlush[][] = []
    const aggregator = new EditAggregator((edits) => seen.push([...edits]), 100)

    aggregator.flush()
    expect(seen).toHaveLength(0)
  })

  it('dispose() drops pending edits without flushing', () => {
    const seen: EditAggregatorFlush[][] = []
    const aggregator = new EditAggregator((edits) => seen.push([...edits]), 100)

    aggregator.record('file:///a.ts')
    aggregator.dispose()
    vi.advanceTimersByTime(1000)

    expect(seen).toHaveLength(0)
  })
})
