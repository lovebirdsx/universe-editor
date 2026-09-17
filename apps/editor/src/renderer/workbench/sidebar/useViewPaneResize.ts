/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  useViewPaneResize — publish a stacked container's pane-resize handler with
 *  IViewPaneResizeRegistry, under each view the container hosts.
 *
 *  The handler closes over the container's latest geometry, so it is kept in a
 *  ref: registration then only churns when the view *set* changes rather than on
 *  every render.
 *--------------------------------------------------------------------------------------------*/

import { useLayoutEffect, useRef } from 'react'
import {
  IViewPaneResizeRegistry,
  type ViewPaneResizeHandler,
} from '../../services/views/viewPaneResizeRegistry.js'
import { useOptionalService } from '../useService.js'

export function useViewPaneResize(
  viewIds: readonly string[],
  handler: ViewPaneResizeHandler,
): void {
  // Optional to keep container component tests independent of the resize subsystem.
  const registry = useOptionalService(IViewPaneResizeRegistry)
  const handlerRef = useRef(handler)
  useLayoutEffect(() => {
    handlerRef.current = handler
  })
  const viewIdsKey = viewIds.join('\n')
  useLayoutEffect(() => {
    // A lone view fills the container: there is no neighbour to trade space with.
    if (!registry || viewIds.length < 2) return
    const registration = registry.register(viewIds, (viewId, deltaPx) =>
      handlerRef.current(viewId, deltaPx),
    )
    return () => registration.dispose()
  }, [registry, viewIdsKey])
}
