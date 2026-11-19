/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Owns a per-view scoped ContextKeyService carrying the `view` key, so
 *  `MenuId.ViewTitle` actions resolve independently for each view. Shared by
 *  ViewPane (multi-view), the SideBar header and ViewContainerHeader (single-view).
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useReducer, useRef } from 'react'
import {
  IContextKeyService,
  markAsSingleton,
  type IScopedContextKeyService,
} from '@universe-editor/platform'
import { useService } from '../useService.js'

export function useViewScopedContextKey(viewId: string | undefined): IContextKeyService {
  const rootCtx = useService(IContextKeyService)
  const scopedRef = useRef<IScopedContextKeyService | null>(null)
  const [, forceUpdate] = useReducer((n: number) => n + 1, 0)

  if (scopedRef.current === null) {
    // React useEffect cleanup disposes on unmount, but beforeunload (page
    // reload / Restart Editor) fires before React teardown — mark singleton
    // so the leak tracker doesn't flag this scoped service and its descendants.
    scopedRef.current = markAsSingleton(rootCtx.createScoped({ view: viewId }))
  }

  useEffect(() => {
    // StrictMode's dev dry-run disposes + nulls the instance created during
    // render before the real mount. Rebuild and re-render so consumers (which
    // read the service during render) keep a live service instead of the
    // thrown-away one whose `view` key now falls through to the root.
    if (scopedRef.current === null) {
      scopedRef.current = markAsSingleton(rootCtx.createScoped({ view: viewId }))
      forceUpdate()
    }
    return () => {
      scopedRef.current?.dispose()
      scopedRef.current = null
    }
  }, [])

  useEffect(() => {
    const s = scopedRef.current
    if (!s) return
    if (viewId) {
      s.set('view', viewId)
    } else {
      s.remove('view')
    }
  }, [viewId])

  return scopedRef.current
}
