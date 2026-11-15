/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Persistent dedupe keys for trigger events. Pure data operations: every mutator
 *  returns a new record so callers can snapshot / persist it cheaply.
 *--------------------------------------------------------------------------------------------*/

export type ProcessedKeyStatus = 'queued' | 'started'

export interface ProcessedEntry {
  readonly at: number
  readonly status: ProcessedKeyStatus
}

export type ProcessedKeys = Record<string, ProcessedEntry>

export interface PruneOptions {
  readonly limit: number
  readonly ttlMs: number
}

export function markQueued(keys: ProcessedKeys, key: string, at: number): ProcessedKeys {
  return { ...keys, [key]: { at, status: 'queued' } }
}

export function markStarted(keys: ProcessedKeys, key: string, at: number): ProcessedKeys {
  return { ...keys, [key]: { at, status: 'started' } }
}

export function forget(keys: ProcessedKeys, key: string): ProcessedKeys {
  if (!Object.hasOwn(keys, key)) return keys
  const next = { ...keys }
  delete next[key]
  return next
}

export function isProcessed(keys: ProcessedKeys, key: string): boolean {
  return Object.hasOwn(keys, key)
}

/**
 * Keeps at most `limit` items from one fetch round. Poll output order is
 * oldest → newest, so the tail is the newest slice; dropping the front bounds
 * the round without evicting keys that were just recorded.
 */
export function newestItems<T>(
  items: readonly T[],
  limit: number,
): { readonly items: readonly T[]; readonly dropped: number } {
  const normalized = Math.max(0, Math.floor(limit))
  if (items.length <= normalized) return { items, dropped: 0 }
  return { items: items.slice(items.length - normalized), dropped: items.length - normalized }
}

/** Drops expired entries, then evicts the oldest until `limit` entries remain. */
export function prune(keys: ProcessedKeys, now: number, options: PruneOptions): ProcessedKeys {
  const alive = Object.entries(keys).filter(([, entry]) => now - entry.at <= options.ttlMs)
  const limit = Math.max(0, Math.floor(options.limit))
  const kept =
    alive.length > limit
      ? alive
          .sort(
            ([leftKey, left], [rightKey, right]) =>
              right.at - left.at || leftKey.localeCompare(rightKey),
          )
          .slice(0, limit)
      : alive
  const next: ProcessedKeys = {}
  for (const [key, entry] of kept) next[key] = entry
  return next
}
