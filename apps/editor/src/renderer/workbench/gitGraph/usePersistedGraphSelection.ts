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
 *
 *  When nothing is restored (fresh session without a stored commit, or a
 *  remount with an empty selection), the first selectable row is selected
 *  through the caller's `selectDefault` — with full click semantics, so the
 *  Commit Changes view shows its changes and a following Enter lands in a
 *  populated view.
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
  /** First selectable row of the current list (synthetic rows already filtered
   *  out by the caller), or null when nothing is visible. */
  readonly defaultRowId: string | null
  /** Select the default row, with the same semantics as clicking it. */
  readonly selectDefault: (id: string) => void
  /** When false, skip the storage read/write (restore starts at 'none') — a
   *  one-shot view (e.g. a scoped Perforce Graph tab) must not pollute workspace
   *  storage or grow a per-path key map without bound. The default-row selection
   *  is unaffected. Defaults to true. */
  readonly persist?: boolean
}

/** Restore decision, in state (not a ref) so the default-selection effect
 *  re-runs when the decision lands. Cached sessions start at 'none'. */
type RestoreState = 'pending' | 'dispatched' | 'none'

export function usePersistedGraphSelection({
  storageKey,
  selection,
  effectiveRepo,
  result,
  pendingReveal,
  excludedIds,
  defaultRowId,
  selectDefault,
  persist = true,
}: UsePersistedGraphSelectionOptions): void {
  const storage = useService(IStorageService)

  const freshSession = result === null
  // null until the storage read settles. Kept in state (not a ref) so the
  // restore effect re-runs when the read lands after the first page, and so
  // writes always merge onto the stored map instead of clobbering the other
  // repos' entries.
  const [storedMap, setStoredMap] = useState<Record<string, string> | null>(null)
  const [restoreState, setRestoreState] = useState<RestoreState>(
    freshSession && persist ? 'pending' : 'none',
  )

  useEffect(() => {
    if (!persist) return
    let cancelled = false
    void storage.get<Record<string, string>>(storageKey, StorageScope.WORKSPACE).then((stored) => {
      if (!cancelled) setStoredMap(stored ?? {})
    })
    return () => {
      cancelled = true
    }
  }, [storage, storageKey, persist])

  // Restore attempt (fresh sessions only). The repo key can resolve after the
  // first page (the repos discovery and the SCM repo mirror land in later
  // commits), so a miss only finalizes once the effective repo is known.
  useEffect(() => {
    if (restoreState !== 'pending') return
    if (storedMap === null || result === null) return
    // A selection already (e.g. the user clicked during the load) wins.
    if (selection.length > 0) {
      setRestoreState('none')
      return
    }
    const hash = storedMap[effectiveRepo ?? '']
    if (hash === undefined) {
      if (effectiveRepo !== null) setRestoreState('none')
      return
    }
    setRestoreState('dispatched')
    pendingReveal.set(hash, undefined)
  }, [restoreState, storedMap, result, effectiveRepo, selection, pendingReveal])

  // Any non-empty selection — user's, restored or defaulted — disarms the
  // default selection, so a later deliberate deselect is never re-selected.
  const defaultDoneRef = useRef(false)
  useEffect(() => {
    if (selection.length > 0) defaultDoneRef.current = true
  }, [selection])

  // Default selection: nothing restored and nothing selected → select the
  // first row with full click semantics. Declared after the restore effect so
  // a reveal dispatched in the same commit is seen here.
  useEffect(() => {
    if (defaultDoneRef.current) return
    if (restoreState !== 'none') return
    if (result === null || selection.length > 0) return
    // A reveal queued before the mount (e.g. `_workbench.openGitGraph <hash>`)
    // owns the selection.
    if (pendingReveal.get() !== null) return
    if (defaultRowId === null) return
    defaultDoneRef.current = true
    selectDefault(defaultRowId)
  }, [restoreState, result, selection, pendingReveal, defaultRowId, selectDefault])

  // Write-back: single selections persist per repo, a deselect clears the
  // repo's entry, and a two-commit compare leaves the persisted focus as is.
  useEffect(() => {
    if (!persist) return
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
  }, [selection, effectiveRepo, storedMap, storage, storageKey, excludedIds, persist])
}
