/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  The invariant under test throughout: the bytes a cache reports as released are the
 *  same bytes it charged. A cache whose measure and release disagree leaves the memory
 *  log lying about where the heap went, which is the one thing this file exists to stop.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { BoundedCache } from '../boundedCache.js'

/** Each value costs its `length` in "bytes", so tests can reason in one unit. */
const measure = (value: string): number => value.length

const cacheOf = (maxEntries: number, maxBytes: number, pinned?: (key: string) => boolean) =>
  new BoundedCache<string>(measure, maxEntries, maxBytes, pinned)

describe('BoundedCache — entry cap', () => {
  it('evicts the oldest once past the entry cap', () => {
    const cache = cacheOf(3, Number.MAX_SAFE_INTEGER)
    for (const key of ['a', 'b', 'c', 'd']) cache.set(key, key)

    expect(cache.size).toBe(3)
    expect(cache.peek('a')).toBeUndefined()
    expect(cache.peek('d')).toBe('d')
    expect(cache.stats()).toMatchObject({ entries: 3, admitted: 4, evicted: 1 })
  })

  it('counts a read as making an entry recent', () => {
    const cache = cacheOf(3, Number.MAX_SAFE_INTEGER)
    for (const key of ['a', 'b', 'c']) cache.set(key, key)
    cache.get('a')
    cache.set('d', 'd')

    expect(cache.peek('a')).toBe('a')
    expect(cache.peek('b')).toBeUndefined()
  })

  it('peek does not affect eviction order', () => {
    const cache = cacheOf(3, Number.MAX_SAFE_INTEGER)
    for (const key of ['a', 'b', 'c']) cache.set(key, key)
    cache.peek('a')
    cache.set('d', 'd')

    expect(cache.peek('a')).toBeUndefined()
  })

  it('re-setting an existing key refreshes it rather than duplicating it', () => {
    const cache = cacheOf(3, Number.MAX_SAFE_INTEGER)
    for (const key of ['a', 'b']) cache.set(key, key)
    cache.set('a', 'aaaa')

    expect(cache.size).toBe(2)
    expect(cache.peek('a')).toBe('aaaa')
    // One byte for 'a' and one for 'b' before the refresh, then four for the new value.
    expect(cache.bytes).toBe(1 + 4)
  })

  it('never evicts the entry it just admitted, however small the cap', () => {
    const cache = cacheOf(1, 1)
    cache.set('only', 'much-too-long')
    expect(cache.peek('only')).toBe('much-too-long')
  })
})

describe('BoundedCache — byte budget', () => {
  it('evicts oldest-first until the budget fits', () => {
    const cache = cacheOf(Number.MAX_SAFE_INTEGER, 10)
    cache.set('a', 'aaaaa')
    cache.set('b', 'bbbbb')
    cache.set('c', 'ccccc')

    expect(cache.bytes).toBeLessThanOrEqual(10)
    expect(cache.peek('a')).toBeUndefined()
    expect(cache.peek('c')).toBe('ccccc')
  })

  it('keeps the tally in step with what it deletes', () => {
    const cache = cacheOf(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)
    cache.set('a', 'aaaa')
    cache.set('b', 'bb')
    expect(cache.bytes).toBe(6)
    cache.delete('a')
    expect(cache.bytes).toBe(2)
    expect(cache.clear()).toBe(2)
    expect(cache.bytes).toBe(0)
    expect(cache.size).toBe(0)
  })
})

describe('BoundedCache — releaseTo', () => {
  it('releases oldest-first and reports exactly what it freed', () => {
    const cache = cacheOf(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)
    cache.set('a', 'aaaaa')
    cache.set('b', 'bbb')
    cache.set('c', 'c')

    const before = cache.bytes
    const freed = cache.releaseTo(4)

    // The report is authoritative: what it says it freed is what left the cache.
    expect(freed).toBe(before - cache.bytes)
    expect(cache.bytes).toBeLessThanOrEqual(4)
    expect(cache.peek('a')).toBeUndefined()
    expect(cache.peek('c')).toBe('c')
  })

  it('is a no-op that reports nothing when already under the target', () => {
    const cache = cacheOf(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)
    cache.set('a', 'aa')
    expect(cache.releaseTo(100)).toBe(0)
    expect(cache.size).toBe(1)
  })

  it('frees everything at a zero target', () => {
    const cache = cacheOf(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)
    cache.set('a', 'aaaaa')
    cache.set('b', 'bbb')
    expect(cache.releaseTo(0)).toBe(8)
    expect(cache.size).toBe(0)
    expect(cache.bytes).toBe(0)
  })
})

describe('BoundedCache — pinned keys', () => {
  it('skips a pinned key however old it is', () => {
    const cache = cacheOf(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, (k) => k === 'a')
    cache.set('a', 'aaaaa')
    cache.set('b', 'bbbbb')
    cache.set('c', 'ccccc')

    const freed = cache.releaseTo(0)
    expect(cache.peek('a')).toBe('aaaaa')
    expect(freed).toBe(10)
    // The pin does not make the cache unbounded: the unpinned content still goes.
    expect(cache.size).toBe(1)
  })

  it('evicts a key once it is unpinned', () => {
    let pinned = true
    const cache = cacheOf(
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
      (k) => pinned && k === 'a',
    )
    cache.set('a', 'aaaaa')
    cache.set('b', 'bbbbb')
    expect(cache.releaseTo(0)).toBe(5)

    pinned = false
    expect(cache.releaseTo(0)).toBe(5)
    expect(cache.size).toBe(0)
  })

  it('gives up rather than looping when everything is pinned', () => {
    const cache = cacheOf(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, () => true)
    cache.set('a', 'aaaaa')
    cache.set('b', 'bbbbb')
    expect(cache.releaseTo(0)).toBe(0)
    expect(cache.size).toBe(2)
  })
})
