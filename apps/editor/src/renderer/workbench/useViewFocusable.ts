/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  useViewFocusable — register a view's focusable element with FocusableRegistry.
 *
 *  Used by view components so `LayoutService.focusView(viewId)` knows which
 *  input/tree inside the subtree should receive focus. The getter is invoked
 *  lazily on each focus request — pass a stable callback that reads from a ref.
 *
 *  `viewId` may be undefined for a component that is only sometimes a view: the
 *  session list renders both as the AGENTS view and inside a popover, and only
 *  the former should claim the id.
 *
 *  A view that registers nothing still gets focus: ViewBody registers the view
 *  container body with `{ fallback: true }`, which the registry consults only
 *  when the view's own target is absent or not yet mounted.
 *--------------------------------------------------------------------------------------------*/

import { useLayoutEffect } from 'react'
import {
  IFocusableRegistry,
  type IFocusableElement,
  type IFocusableRegistrationOptions,
} from '@universe-editor/platform'
import { useOptionalService } from './useService.js'

export function useViewFocusable(
  viewId: string | undefined,
  getElement: () => IFocusableElement | null,
  options?: IFocusableRegistrationOptions,
): void {
  // Optional to keep view component tests independent of the focus subsystem.
  const registry = useOptionalService(IFocusableRegistry)
  const fallback = options?.fallback ?? false
  useLayoutEffect(() => {
    if (!registry || viewId === undefined) return
    const d = registry.register(viewId, getElement, { fallback })
    return () => d.dispose()
  }, [registry, viewId, getElement, fallback])
}
