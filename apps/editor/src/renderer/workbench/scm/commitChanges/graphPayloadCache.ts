/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  graphPayloadCache — session-scoped cache of built ShowCommitChangesPayloads
 *  for the graph editors' Commit Changes handoff (shared by git and perforce).
 *  Commit / submitted-changelist contents are immutable for a given ref, so a
 *  repeat click on an already-seen commit applies instantly instead of
 *  re-spawning git/p4. In-flight builds are cached as promises, so concurrent
 *  requests for the same ref (e.g. a silent follow racing a deliberate click)
 *  share one fetch. LRU-bounded so a long session can't grow it without limit.
 *--------------------------------------------------------------------------------------------*/

import type { ShowCommitChangesPayload } from '@universe-editor/extensions-common'

const MAX_CACHED_PAYLOADS = 50

type CacheEntry = ShowCommitChangesPayload | Promise<ShowCommitChangesPayload | null>

const cache = new Map<string, CacheEntry>()

function touch(key: string, entry: CacheEntry): void {
  cache.delete(key)
  cache.set(key, entry)
}

/** Returns the cached payload for `key`, building (and caching) it on a miss.
 *  A build that resolves null or rejects is NOT cached, so a transient failure
 *  doesn't poison the ref. The caller composes the key — include the provider
 *  id and repo root so identical refs across repos never collide. */
export function getOrBuildGraphPayload(
  key: string,
  build: () => Promise<ShowCommitChangesPayload | null>,
): Promise<ShowCommitChangesPayload | null> {
  const hit = cache.get(key)
  if (hit !== undefined) {
    touch(key, hit)
    return Promise.resolve(hit)
  }
  const pending: Promise<ShowCommitChangesPayload | null> = build().then(
    (payload) => {
      if (payload === null) {
        if (cache.get(key) === pending) cache.delete(key)
      } else {
        touch(key, payload)
      }
      return payload
    },
    (err: unknown) => {
      if (cache.get(key) === pending) cache.delete(key)
      throw err
    },
  )
  cache.set(key, pending)
  while (cache.size > MAX_CACHED_PAYLOADS) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
  return pending
}

export function _clearGraphPayloadCacheForTests(): void {
  cache.clear()
}
