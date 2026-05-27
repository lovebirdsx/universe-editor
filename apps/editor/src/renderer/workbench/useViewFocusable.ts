/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  useViewFocusable — register a view's focusable element with FocusableRegistry.
 *
 *  Used by view components so `LayoutService.focusView(viewId)` knows which
 *  input/tree inside the subtree should receive focus. The getter is invoked
 *  lazily on each focus request — pass a stable callback that reads from a ref.
 *--------------------------------------------------------------------------------------------*/

import { useLayoutEffect } from 'react'
import { IFocusableRegistry, type IFocusableElement } from '@universe-editor/platform'
import { useOptionalService } from './useService.js'

export function useViewFocusable(viewId: string, getElement: () => IFocusableElement | null): void {
  // Optional to keep view component tests independent of the focus subsystem.
  const registry = useOptionalService(IFocusableRegistry)
  useLayoutEffect(() => {
    if (!registry) return
    const d = registry.register(viewId, getElement)
    return () => d.dispose()
  }, [registry, viewId, getElement])
}
