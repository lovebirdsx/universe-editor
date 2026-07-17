/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  useScrollRestore — restore a scroll container's `scrollTop` on mount and save
 *  it on unmount, through the module-level ScrollStateCache. Pass a stable `key`
 *  identifying the logical view (undefined disables it entirely) and a getter for
 *  the scroll element, resolved lazily on each mount/unmount so it works whether
 *  the scroller is the component's own element or one nested inside (e.g. the
 *  VirtualList parent in virtual mode).
 *--------------------------------------------------------------------------------------------*/

import { useLayoutEffect } from 'react'
import { ScrollStateCache } from './scrollStateCache.js'

export function useScrollRestore(
  key: string | undefined,
  getScrollElement: () => HTMLElement | null,
): void {
  useLayoutEffect(() => {
    if (key === undefined) return
    const el = getScrollElement()
    if (el) {
      const saved = ScrollStateCache.load(key)
      if (saved !== undefined) el.scrollTop = saved
    }
    return () => {
      // Re-resolve on cleanup: the element captured on mount may have been
      // swapped (e.g. crossing the virtualization threshold) during the view's
      // lifetime, so read the current scroller's position at unmount time.
      const current = getScrollElement()
      if (current) ScrollStateCache.save(key, current.scrollTop)
    }
    // getScrollElement is expected to be stable (reads from a ref); keyed only on
    // `key` so a key change saves the old view and restores the new one.
  }, [key])
}
