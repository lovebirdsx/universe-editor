/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  scmTreeState — per-repository persistence of the SCM tree's view state
 *  (collapsed node ids + scroll position).
 *
 *  The SCM view owns its TreeModel in the component (useOwnedTreeModel), so
 *  switching the sidebar container, switching repositories, or reloading the
 *  window disposes the model and resets every group/folder to expanded. This
 *  module mirrors the user's folding + scroll position into WORKSPACE storage
 *  so the next mount can restore them.
 *
 *  Reads are synchronous (peek*): ScmView prefetches the selected repository's
 *  state before mounting ScmProviderView, so the TreeModel is seeded in its
 *  create callback and the first paint already reflects the restored folding
 *  (no expand-then-collapse flash). Writes are debounced: expansion changes
 *  also fire on data refreshes, and scroll positions churn during scrolling.
 *--------------------------------------------------------------------------------------------*/

import { IStorageService, StorageScope } from '@universe-editor/platform'

const STORAGE_KEY_PREFIX = 'scm/treeState/'
const PERSIST_DEBOUNCE_MS = 300

interface ScmTreePersistedState {
  readonly collapsedIds?: readonly string[]
  readonly scrollTop?: number
}

interface ScmTreeCachedState {
  collapsedIds: readonly string[]
  scrollTop: number | undefined
}

const cache = new Map<string, ScmTreeCachedState>()
const pendingWrites = new Map<string, ReturnType<typeof setTimeout>>()

function storageKey(repoKey: string): string {
  return `${STORAGE_KEY_PREFIX}${repoKey}`
}

/**
 * Load the persisted state for `repoKey` into the module cache. Must be
 * awaited before the repository's ScmProviderView mounts — peek* only see
 * what has been prefetched.
 */
export async function prefetchScmTreeState(
  storage: IStorageService,
  repoKey: string,
): Promise<void> {
  if (cache.has(repoKey)) return
  const stored = await storage.get<ScmTreePersistedState>(
    storageKey(repoKey),
    StorageScope.WORKSPACE,
  )
  // A slow prefetch may race a peek-side update that already seeded the cache
  // (e.g. the view mounted without waiting); don't clobber fresher state.
  if (cache.has(repoKey)) return
  cache.set(repoKey, {
    collapsedIds: Array.isArray(stored?.collapsedIds)
      ? stored.collapsedIds.filter((id): id is string => typeof id === 'string')
      : [],
    scrollTop: typeof stored?.scrollTop === 'number' ? stored.scrollTop : undefined,
  })
}

/** Collapsed node ids restored for this repo — undefined until prefetched. */
export function peekCollapsedIds(repoKey: string): readonly string[] | undefined {
  return cache.get(repoKey)?.collapsedIds
}

/** Last persisted scroll position — undefined until prefetched (or never scrolled). */
export function peekScrollTop(repoKey: string): number | undefined {
  return cache.get(repoKey)?.scrollTop
}

export function persistCollapsedIds(
  storage: IStorageService,
  repoKey: string,
  collapsedIds: readonly string[],
): void {
  const entry = cache.get(repoKey) ?? { collapsedIds: [], scrollTop: undefined }
  if (sameIds(entry.collapsedIds, collapsedIds)) return
  cache.set(repoKey, { ...entry, collapsedIds: [...collapsedIds] })
  scheduleWrite(storage, repoKey)
}

// Scroll saves fire once per unmount — no debounce. The write must land before
// the window tears down; a debounced timer would be lost on reload.
export function persistScrollTop(storage: IStorageService, repoKey: string, top: number): void {
  const entry = cache.get(repoKey) ?? { collapsedIds: [], scrollTop: undefined }
  if (entry.scrollTop === top) return
  cache.set(repoKey, { ...entry, scrollTop: top })
  writeNow(storage, repoKey)
}

function scheduleWrite(storage: IStorageService, repoKey: string): void {
  const pending = pendingWrites.get(repoKey)
  if (pending !== undefined) clearTimeout(pending)
  pendingWrites.set(
    repoKey,
    setTimeout(() => {
      pendingWrites.delete(repoKey)
      writeNow(storage, repoKey)
    }, PERSIST_DEBOUNCE_MS),
  )
}

function writeNow(storage: IStorageService, repoKey: string): void {
  const entry = cache.get(repoKey)
  if (!entry) return
  const state: ScmTreePersistedState = {
    collapsedIds: entry.collapsedIds,
    ...(entry.scrollTop !== undefined ? { scrollTop: entry.scrollTop } : {}),
  }
  void storage.set(storageKey(repoKey), state, StorageScope.WORKSPACE)
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const set = new Set(a)
  for (const id of b) if (!set.has(id)) return false
  return true
}

export function _resetScmTreeStateForTests(): void {
  for (const id of pendingWrites.values()) clearTimeout(id)
  pendingWrites.clear()
  cache.clear()
}
