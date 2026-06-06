/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  useOwnedTreeModel — own a TreeModel's lifecycle from a React component.
 *
 *  A view without a backing DI service (e.g. Scm) must create its TreeModel in
 *  the component and dispose it on unmount. The naive useMemo+dispose pattern
 *  breaks under React StrictMode: its mount→unmount→mount dry run disposes the
 *  memoized model, and the remount reuses the same dead instance whose emitters
 *  no longer fire or accept listeners — so the tree never updates again.
 *
 *  This hook recreates the model whenever a prior cleanup disposed it, so the
 *  live component always holds a working model.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useRef, useState } from 'react'
import { markAsSingleton } from '@universe-editor/platform'
import { type TreeModel } from './TreeModel.js'

export function useOwnedTreeModel<T>(create: () => TreeModel<T>): TreeModel<T> {
  // The model is constructed during render. StrictMode double-invokes render and
  // concurrent renders may be discarded, so create() can run more than once and
  // produce instances React never commits. Two safeguards:
  //  1. A ref guard keeps the common path to a single instance per generation
  //     (a useState lazy initializer would instead orphan its second call).
  //  2. `created` records every instance built so unmount disposes them all,
  //     not just the committed one — discarded-render instances included.
  // Each is also marked as a singleton: on a page reload the beforeunload
  // handler unmounts and snapshots leaks before passive cleanup flushes, which
  // would otherwise report these as leaks. A normal unmount still disposes them.
  const created = useRef<Set<TreeModel<T>> | null>(null)
  created.current ??= new Set()
  const ref = useRef<TreeModel<T> | null>(null)
  if (ref.current === null || ref.current.isDisposed) {
    ref.current = markAsSingleton(create())
    created.current.add(ref.current)
  }
  const model = ref.current

  const [, forceRebuild] = useState(0)
  useEffect(() => {
    if (model.isDisposed) {
      // A StrictMode dry-run cleanup disposed it before this effect committed;
      // re-render so the guard above builds a live model.
      forceRebuild((v) => v + 1)
      return
    }
    return () => model.dispose()
    // `create` is a closure over stable refs; re-running on its identity is unwanted.
  }, [model])

  useEffect(() => {
    const all = created.current
    if (!all) return
    return () => {
      for (const m of all) if (!m.isDisposed) m.dispose()
      all.clear()
    }
  }, [])

  return model
}
