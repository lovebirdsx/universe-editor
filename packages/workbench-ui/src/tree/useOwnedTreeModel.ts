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

import { useEffect, useState } from 'react'
import { type TreeModel } from './TreeModel.js'

export function useOwnedTreeModel<T>(create: () => TreeModel<T>): TreeModel<T> {
  const [model, setModel] = useState(create)
  useEffect(() => {
    if (model.isDisposed) {
      // A StrictMode dry-run unmount disposed it; recreate so the remounted
      // component (and the next effect run) gets a live model.
      setModel(create())
      return
    }
    return () => model.dispose()
    // `create` is a closure over stable refs; re-running on its identity is unwanted.
  }, [model])
  return model
}
