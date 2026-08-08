/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  usePersistedGraphSelection — persist the graph's focused commit across
 *  sessions, shared by the Git Graph and Perforce Graph editors. The selection
 *  already survives tab remounts via the module-level view-state singletons;
 *  this hook adds the cross-session leg: the last single-selected commit is
 *  written to storage per repository, and on a fresh session (no cached
 *  result at mount) the stored commit is revealed again once the first page
 *  and the repo resolution land. The restore reuses the pendingReveal reveal
 *  path, so paging/scroll/selection semantics match an explicit "Open in
 *  Graph"; its silent follow into the Commit Changes view stays gated by
 *  `shouldFollowGraphSelection` and never pops the sidebar on startup.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useRef, useState } from 'react'
import { IStorageService, StorageScope, type ISettableObservable } from '@universe-editor/platform'
import { useService } from '../useService.js'

export interface UsePersistedGraphSelectionOptions {
  /** Workspace-scoped storage key, e.g. 'gitGraph.lastSelectedCommit'. */
  readonly storageKey: string
  /** Current selection (component state mirrored from the module store). */
  readonly selection: readonly string[]
  /** Effective repo root, or null until the repo list resolves. */
  readonly effectiveRepo: string | null
  /** The loaded result (null until the first page lands). Its value at mount
   *  decides the session kind: non-null means the tab is rehydrating from the
   *  in-memory cache, so no storage restore runs. */
  readonly result: unknown
  /** Reveal channel consumed by the mounted editor's reveal effect. */
  readonly pendingReveal: ISettableObservable<string | null>
  /** Synthetic row ids (uncommitted / pending nodes) that must not be persisted. */
  readonly excludedIds: readonly string[]
}

export function usePersistedGraphSelection({
  storageKey,
  selection,
  effectiveRepo,
  result,
  pendingReveal,
  excludedIds,
}: UsePersistedGraphSelectionOptions): void {
  const storage = useService(IStorageService)

  const freshSessionRef = useRef(result === null)
  // null until the storage read settles. Kept in state (not a ref) so the
  // restore effect re-runs when the read lands after the first page, and so
  // writes always merge onto the stored map instead of clobbering the other
  // repos' entries.
  const [storedMap, setStoredMap] = useState<Record<string, string> | null>(null)
  const restoreDoneRef = useRef(false)

  useEffect(() => {
    let cancelled = false
    void storage.get<Record<string, string>>(storageKey, StorageScope.WORKSPACE).then((stored) => {
      if (!cancelled) setStoredMap(stored ?? {})
    })
    return () => {
      cancelled = true
    }
  }, [storage, storageKey])

  // Restore attempt (fresh sessions only). The repo key can resolve after the
  // first page (the repos discovery and the SCM repo mirror land in later
  // commits), so a miss only finalizes once the effective repo is known.
  useEffect(() => {
    if (!freshSessionRef.current || restoreDoneRef.current) return
    if (storedMap === null || result === null) return
    // A selection already (e.g. the user clicked during the load) wins.
    if (selection.length > 0) {
      restoreDoneRef.current = true
      return
    }
    const hash = storedMap[effectiveRepo ?? '']
    if (hash === undefined) {
      if (effectiveRepo !== null) restoreDoneRef.current = true
      return
    }
    restoreDoneRef.current = true
    pendingReveal.set(hash, undefined)
  }, [storedMap, result, effectiveRepo, selection, pendingReveal])

  // Write-back: single selections persist per repo, a deselect clears the
  // repo's entry, and a two-commit compare leaves the persisted focus as is.
  useEffect(() => {
    if (storedMap === null) return
    const key = effectiveRepo ?? ''
    if (selection.length === 1 && !excludedIds.includes(selection[0]!)) {
      const hash = selection[0]!
      if (storedMap[key] === hash) return
      const next = { ...storedMap, [key]: hash }
      setStoredMap(next)
      void storage.set(storageKey, next, StorageScope.WORKSPACE)
    } else if (selection.length === 0) {
      if (!(key in storedMap)) return
      const next = { ...storedMap }
      delete next[key]
      setStoredMap(next)
      void storage.set(storageKey, next, StorageScope.WORKSPACE)
    }
  }, [selection, effectiveRepo, storedMap, storage, storageKey, excludedIds])
}
