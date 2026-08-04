/*---------------------------------------------------------------------------------------------
 *  Tests for packages/platform/src/telemetry/errorAggregation.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { AggregationBuffer } from '../../telemetry/errorAggregation.js'

interface ITestEntry {
  readonly key: string
  count: number
  readonly payload: string
}

function entry(key: string, count = 1, payload = key): ITestEntry {
  return { key, count, payload }
}

describe('AggregationBuffer', () => {
  it('appends new keys', () => {
    const buf = new AggregationBuffer<ITestEntry>((e) => e.key)
    buf.insert(entry('a'))
    buf.insert(entry('b'))
    expect(buf.size).toBe(2)
  })

  it('merges count for the same key and keeps the first entry', () => {
    const buf = new AggregationBuffer<ITestEntry>((e) => e.key)
    buf.insert(entry('a', 1, 'first'))
    buf.insert(entry('a', 4, 'later'))
    expect(buf.size).toBe(1)
    const [merged] = buf.flush()
    expect(merged?.count).toBe(5)
    expect(merged?.payload).toBe('first')
  })

  it('keeps entries sorted regardless of insertion order', () => {
    const buf = new AggregationBuffer<ITestEntry>((e) => e.key)
    for (const k of ['m', 'a', 'z', 'c', 'b']) buf.insert(entry(k))
    expect(buf.flush().map((e) => e.key)).toEqual(['a', 'b', 'c', 'm', 'z'])
  })

  it('merges out-of-order duplicates correctly', () => {
    const buf = new AggregationBuffer<ITestEntry>((e) => e.key)
    buf.insert(entry('c'))
    buf.insert(entry('a'))
    buf.insert(entry('c', 2))
    buf.insert(entry('a', 3))
    const drained = buf.flush()
    expect(drained).toHaveLength(2)
    expect(drained[0]).toMatchObject({ key: 'a', count: 4 })
    expect(drained[1]).toMatchObject({ key: 'c', count: 3 })
  })

  it('invokes the merge callback on duplicates', () => {
    const merge = vi.fn((existing: ITestEntry, incoming: ITestEntry) => {
      void existing
      void incoming
    })
    const buf = new AggregationBuffer<ITestEntry>((e) => e.key, merge)
    buf.insert(entry('a'))
    buf.insert(entry('a'))
    expect(merge).toHaveBeenCalledTimes(1)
  })

  it('flush drains the buffer', () => {
    const buf = new AggregationBuffer<ITestEntry>((e) => e.key)
    buf.insert(entry('a'))
    buf.flush()
    expect(buf.size).toBe(0)
    expect(buf.flush()).toEqual([])
  })
})
