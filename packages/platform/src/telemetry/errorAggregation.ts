/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Dedup buffer for error events, modeled on VSCode's BaseErrorTelemetry:
 *  entries are kept sorted by key and located via binary search, so a repeated
 *  error only bumps `count` on the existing entry instead of appending a new
 *  one. The owner decides when to flush (batch timer, immediate on error).
 *--------------------------------------------------------------------------------------------*/

export interface IAggregatedEntry {
  count: number
}

export class AggregationBuffer<T extends IAggregatedEntry> {
  private _entries: { key: string; entry: T }[] = []

  constructor(
    private readonly _keyOf: (entry: T) => string,
    private readonly _merge?: (existing: T, incoming: T) => void,
  ) {}

  get size(): number {
    return this._entries.length
  }

  insert(entry: T): void {
    const key = this._keyOf(entry)
    const idx = this._binarySearch(key)
    if (idx >= 0) {
      const existing = this._entries[idx]
      if (existing) {
        existing.entry.count += entry.count
        this._merge?.(existing.entry, entry)
      }
      return
    }
    this._entries.splice(~idx, 0, { key, entry })
  }

  /** Drain and return all entries in key order. */
  flush(): T[] {
    const drained = this._entries.map((e) => e.entry)
    this._entries = []
    return drained
  }

  private _binarySearch(key: string): number {
    let low = 0
    let high = this._entries.length - 1
    while (low <= high) {
      const mid = (low + high) >> 1
      const midKey = this._entries[mid]?.key
      if (midKey === undefined) return -1
      if (midKey === key) return mid
      if (midKey < key) low = mid + 1
      else high = mid - 1
    }
    return ~low
  }
}
