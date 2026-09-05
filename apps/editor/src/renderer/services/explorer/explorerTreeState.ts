/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  explorerTreeState — per-workspace-root persistence of the Explorer tree's
 *  expansion state (expanded directory ids).
 *
 *  ExplorerTreeService owns its TreeModel as a DI singleton, so the model lives
 *  across the whole app — but switching workspace folders (`_setRoot`) resets
 *  every node, and reloading the window rebuilds the model entirely. This module
 *  mirrors the user's expanded-directory set into WORKSPACE storage so the next
 *  `_setRoot` for the same root can restore it.
 *
 *  Unlike scmTreeState there is no prefetch/peek cache: the Explorer restore is
 *  fully asynchronous (the model must lazily load children as it re-expands), so
 *  nothing needs a synchronous seed read. Writes are debounced — expansion
 *  flips arrive one per user gesture and also burst during restore.
 *
 *  The storage key carries the root URI: WORKSPACE scope already isolates per
 *  workspace, but a debounced write scheduled just before a workspace switch
 *  could otherwise land in the *new* workspace's bucket. A root-scoped key makes
 *  that stray write harmless — the new root never reads the old root's key.
 *--------------------------------------------------------------------------------------------*/

import { IStorageService, StorageScope, URI } from '@universe-editor/platform'
import { normalizeUri } from './explorerTreeUtils.js'

const STORAGE_KEY_PREFIX = 'explorer/treeState/'
const PERSIST_DEBOUNCE_MS = 300

export interface ExplorerTreePersistedState {
  readonly expandedIds: readonly string[]
}

interface PendingWrite {
  timer: ReturnType<typeof setTimeout>
  ids: readonly string[]
}

const pendingWrites = new Map<string, PendingWrite>()
// Last set we accepted for a key — dedupes writes across debounce windows (a
// flushed write clears pendingWrites, so without this a refresh-driven
// re-derivation of the same set would rewrite it).
const lastWritten = new Map<string, readonly string[]>()

export function storageKeyForRoot(root: URI): string {
  return `${STORAGE_KEY_PREFIX}${normalizeUri(root).toString()}`
}

/**
 * The set we last accepted for `key` (a pending debounced write wins over an
 * already-flushed one). Lets a caller compare a freshly-derived snapshot
 * against what storage will hold without triggering a write — used by the
 * restore path to self-heal only when the restored set actually diverged.
 */
export function lastAcceptedExpandedIds(key: string): readonly string[] | undefined {
  return pendingWrites.get(key)?.ids ?? lastWritten.get(key)
}

/**
 * Schedule a debounced write of the expanded-id set for `key`. Identical sets
 * are dropped (no churn on refresh-driven re-derivation); a newer set cancels
 * the pending write so the last snapshot always wins.
 */
export function persistExpandedIds(
  storage: IStorageService,
  key: string,
  expandedIds: readonly string[],
): void {
  const pending = pendingWrites.get(key)
  const current = pending?.ids ?? lastWritten.get(key)
  if (current !== undefined && sameIds(current, expandedIds)) return
  if (pending !== undefined) clearTimeout(pending.timer)
  pendingWrites.set(key, {
    ids: [...expandedIds],
    timer: setTimeout(() => {
      pendingWrites.delete(key)
      lastWritten.set(key, [...expandedIds])
      void writeNow(storage, key, expandedIds)
    }, PERSIST_DEBOUNCE_MS),
  })
}

/** Cancel any pending debounced write for `key` and persist the latest set immediately. */
export function flushExpandedIdsWrite(
  storage: IStorageService,
  key: string,
  ids: readonly string[],
): void {
  const pending = pendingWrites.get(key)
  if (pending !== undefined) {
    clearTimeout(pending.timer)
    pendingWrites.delete(key)
    ids = pending.ids
  }
  lastWritten.set(key, [...ids])
  void writeNow(storage, key, ids)
}

async function writeNow(
  storage: IStorageService,
  key: string,
  expandedIds: readonly string[],
): Promise<void> {
  const state: ExplorerTreePersistedState = { expandedIds: [...expandedIds] }
  await storage.set(key, state, StorageScope.WORKSPACE)
}

/** Order-insensitive id-set equality (persisted order is not meaningful). */
export function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a)
  for (const id of b) if (!set.has(id)) return false
  return true
}

export function _resetExplorerTreeStateForTests(): void {
  for (const pending of pendingWrites.values()) clearTimeout(pending.timer)
  pendingWrites.clear()
  lastWritten.clear()
}
