/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  useTreeModel — thin React binding for TreeModel.
 *
 *  Two separate counters keep structure changes apart from selection changes:
 *  the visible-rows array only re-derives when the structure version bumps,
 *  while selection updates reach rows through their boolean props so memoized
 *  rows can short-circuit. Mirrors the original ExplorerView optimisation.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useMemo, useState } from 'react'
import { combinedDisposable, markAsSingleton } from '@universe-editor/platform'
import { type IVisibleNode, type TreeModel } from './TreeModel.js'

export interface ITreeModelBinding<T> {
  readonly structureVersion: number
  readonly selectionVersion: number
  readonly visibleNodes: readonly IVisibleNode<T>[]
}

export function useTreeModel<T>(model: TreeModel<T>): ITreeModelBinding<T> {
  const [structureVersion, setStructureVersion] = useState(0)
  const [selectionVersion, setSelectionVersion] = useState(0)

  useEffect(() => {
    const ds = model.onDidChangeStructure(() => setStructureVersion((v) => v + 1))
    const sel = model.onDidChangeSelection(() => setSelectionVersion((v) => v + 1))
    // React owns these via this cleanup. On a page reload the beforeunload
    // handler unmounts before passive-effect cleanup flushes, so mark them as
    // singletons to keep the leak tracker from reporting them; a normal unmount
    // still disposes them. Mirrors useTitleBarMenus.
    const combined = markAsSingleton(combinedDisposable(ds, sel))
    return () => combined.dispose()
  }, [model])

  const visibleNodes = useMemo(
    () => model.getVisibleNodes(),
    // structureVersion intentionally drives this; the model caches by the same
    // counter, so any value that changes when structure mutates suffices.
    [model, structureVersion],
  )

  return { structureVersion, selectionVersion, visibleNodes }
}
