/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  A keyed store with an entry cap, a byte budget and LRU eviction, plus a record of
 *  what it has given back.
 *
 *  Extracted because several renderer caches needed exactly this and each had grown its
 *  own partial version — two of them with no bound at all. The measure function is shared
 *  between the admission decision and the release report on purpose: a cache that
 *  charged one number and reported another would leave the memory log lying about where
 *  the heap went, and the resident budget cannot reconcile bytes it cannot see.
 *--------------------------------------------------------------------------------------------*/

export interface BoundedCacheStats {
  readonly entries: number
  readonly bytes: number
  /** Entries ever admitted — a quickly-growing count next to a flat `entries` is the
   *  signature of a key that keeps changing (a fingerprint, a scope id). */
  readonly admitted: number
  readonly evicted: number
}

export class BoundedCache<T> {
  /** Map iteration order is insertion order, which is what makes this an LRU: a read
   *  re-inserts, so the oldest key is always the first one out. */
  private readonly _map = new Map<string, T>()
  private _bytes = 0
  private _admitted = 0
  private _evicted = 0

  constructor(
    private readonly _measure: (value: T) => number,
    private readonly _maxEntries: number,
    private readonly _maxBytes: number,
    /**
     * Keys exempt from eviction — the session the user is looking at now. Note that a
     * pinned key is skipped rather than counted, so `maxEntries` is a soft bound while
     * pins exist: enough simultaneous pins can carry the cache over it. Callers pin the
     * on-screen session only, so the overshoot is one or two entries, not unbounded.
     */
    private readonly _isPinned?: (key: string) => boolean,
  ) {}

  get size(): number {
    return this._map.size
  }

  get bytes(): number {
    return this._bytes
  }

  has(key: string): boolean {
    return this._map.has(key)
  }

  /** Read and mark recent. */
  get(key: string): T | undefined {
    const value = this._map.get(key)
    if (value === undefined) return undefined
    this._map.delete(key)
    this._map.set(key, value)
    return value
  }

  /** Read without affecting eviction order. */
  peek(key: string): T | undefined {
    return this._map.get(key)
  }

  keys(): IterableIterator<string> {
    return this._map.keys()
  }

  set(key: string, value: T): void {
    const existing = this._map.get(key)
    if (existing !== undefined) {
      this._bytes -= this._measure(existing)
      this._map.delete(key)
    }
    this._map.set(key, value)
    this._bytes += this._measure(value)
    this._admitted++
    this._evictToLimits()
  }

  delete(key: string): boolean {
    const value = this._map.get(key)
    if (value === undefined) return false
    this._map.delete(key)
    this._bytes -= this._measure(value)
    return true
  }

  /** Drop everything, returning the bytes released. */
  clear(): number {
    const freed = this._bytes
    this._map.clear()
    this._bytes = 0
    return freed
  }

  stats(): BoundedCacheStats {
    return {
      entries: this._map.size,
      bytes: this._bytes,
      admitted: this._admitted,
      evicted: this._evicted,
    }
  }

  /**
   * Evict oldest-first until the cache is inside `maxBytes`, returning the bytes
   * released. Pinned keys are skipped, so the current session keeps its content even
   * when it is the oldest thing in the cache.
   *
   * Unlike the cap-driven eviction on `set`, this may empty the cache entirely: it
   * answers an explicit external demand for memory, where a cache that kept one entry
   * back would be refusing the exact request it was asked to serve.
   */
  releaseTo(maxBytes: number): number {
    return this._evict(maxBytes, Number.MAX_SAFE_INTEGER, false)
  }

  private _evictToLimits(): void {
    this._evict(this._maxBytes, this._maxEntries, true)
  }

  private _evict(maxBytes: number, maxEntries: number, keepLast: boolean): number {
    let freed = 0
    for (const key of [...this._map.keys()]) {
      if (this._bytes <= maxBytes && this._map.size <= maxEntries) break
      // On the cap-driven path, stop before the last entry: the thing just admitted is
      // the thing most likely to be wanted, and evicting it immediately would make
      // `set` a no-op that still charged for producing the value.
      if (keepLast && this._map.size <= 1) break
      if (this._isPinned?.(key) === true) continue
      const value = this._map.get(key)
      if (value === undefined) continue
      const bytes = this._measure(value)
      this._map.delete(key)
      // Decremented inside the loop: the stopping condition reads this tally, so
      // deferring it to the end would keep the cache "over budget" and evict
      // everything down to the last entry.
      this._bytes -= bytes
      freed += bytes
      this._evicted++
    }
    if (this._bytes < 0) this._bytes = this._recount()
    return freed
  }

  private _recount(): number {
    let bytes = 0
    for (const value of this._map.values()) bytes += this._measure(value)
    return bytes
  }
}
