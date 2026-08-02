/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  diffModelCache — a small LRU of live Monaco model pairs for re-opened diff
 *  editors. Rebuilding a diff tab's models costs two createModel + full
 *  tokenization passes plus a fresh Monaco diff computation, which dominates
 *  the perceived cost of closing and reopening a large diff (or switching away
 *  and back when the tab unmounts). Since the diff's text already lives in the
 *  EditorInput, caching the *models* lets a reopen skip everything.
 *
 *  Ownership: `storeDiffModels` hands the pair to the cache (the cache disposes
 *  it on eviction/replacement/discard); `acquireDiffModels` hands it back to the
 *  caller. A pair is never shared with two live editors at once — an open swarm
 *  diff tab's id is unique, and its models are stored only when it unmounts.
 *--------------------------------------------------------------------------------------------*/

import type { monaco } from '../../workbench/editor/monaco/MonacoLoader.js'

export interface DiffModelPair {
  readonly original: monaco.editor.ITextModel
  readonly modified: monaco.editor.ITextModel
}

/** Bounds memory: each entry holds two full text models. */
const MAX_ENTRIES = 8

/** Insertion-ordered; LRU refresh = delete + set. */
const entries = new Map<string, DiffModelPair>()

function disposePair(pair: DiffModelPair): void {
  pair.original.dispose()
  pair.modified.dispose()
}

/**
 * Take the pair cached under `key` out of the cache (caller owns it), or
 * undefined on a miss. The expected texts are verified against the live models:
 * a same-id diff whose content changed while unmounted (a re-shelved pending
 * version, fetched fresh on reopen) must not resurrect stale text — the pair is
 * disposed and reported as a miss so the caller rebuilds.
 */
export function acquireDiffModels(
  key: string,
  expected: { readonly originalText: string; readonly modifiedText: string },
): DiffModelPair | undefined {
  const hit = entries.get(key)
  if (!hit) return undefined
  entries.delete(key)
  if (
    hit.original.getValue() !== expected.originalText ||
    hit.modified.getValue() !== expected.modifiedText
  ) {
    disposePair(hit)
    return undefined
  }
  return hit
}

/** Hand a pair to the cache; the cache owns its disposal from here. */
export function storeDiffModels(
  key: string,
  original: monaco.editor.ITextModel,
  modified: monaco.editor.ITextModel,
): void {
  const prev = entries.get(key)
  if (prev) {
    entries.delete(key)
    disposePair(prev)
  }
  entries.set(key, { original, modified })
  while (entries.size > MAX_ENTRIES) {
    const oldestKey = entries.keys().next().value
    if (oldestKey === undefined) break
    const oldest = entries.get(oldestKey)
    entries.delete(oldestKey)
    if (oldest) disposePair(oldest)
  }
}

/** Drop one entry without returning it (e.g. its tab closed for good). */
export function discardDiffModels(key: string): void {
  const hit = entries.get(key)
  if (hit) {
    entries.delete(key)
    disposePair(hit)
  }
}

export function _resetDiffModelCacheForTests(): void {
  for (const pair of entries.values()) disposePair(pair)
  entries.clear()
}
