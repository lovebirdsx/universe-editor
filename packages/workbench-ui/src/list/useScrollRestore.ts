/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  useScrollRestore — restore a scroll container's `scrollTop` on mount and save
 *  it on unmount, through the module-level ScrollStateCache. Pass a stable `key`
 *  identifying the logical view (undefined disables it entirely) and a getter for
 *  the scroll element, resolved lazily on each mount/unmount so it works whether
 *  the scroller is the component's own element or one nested inside (e.g. the
 *  VirtualList parent in virtual mode).
 *
 *  Restoration can't happen in a single synchronous pass: the scroller may not
 *  exist yet at mount (it's rendered behind an async "no content" placeholder,
 *  e.g. the AGENTS session list before its history observable hydrates), it may
 *  live in an Allotment pane that isn't sized until a later layout tick, and its
 *  content may stream in and grow `scrollHeight` after mount. A ResizeObserver
 *  only fires on the observed element's own box, so it misses a `scrollHeight`
 *  that grows while `clientHeight` (a `flex: 1` box) stays constant. Instead we
 *  poll across a few animation frames until the target sticks (or the window
 *  closes), which covers all three delays uniformly.
 *
 *  The subtle failure this guards against: the host view can remount twice in
 *  quick succession (an observable settling right after the container becomes
 *  visible). The short-lived middle mount sees the scroller before its pane is
 *  sized — `scrollTop` clamps to 0 because there's no range yet. If its cleanup
 *  saved that spurious 0 it would clobber the real position we hadn't managed to
 *  reapply. So cleanup persists the current position only once restoration has
 *  actually succeeded (or there was no positive position to protect); otherwise
 *  it leaves the saved value untouched for the next mount to retry against.
 *--------------------------------------------------------------------------------------------*/

import { useLayoutEffect } from 'react'
import { ScrollStateCache } from './scrollStateCache.js'

// Upper bound on how long we keep trying to reapply the saved position. Long
// enough to outlast an async content hydrate + pane layout, short enough that it
// never fights a user who starts scrolling right after the view reappears.
const RESTORE_WINDOW_MS = 1000

export function useScrollRestore(
  key: string | undefined,
  getScrollElement: () => HTMLElement | null,
): void {
  useLayoutEffect(() => {
    if (key === undefined) return
    const saved = ScrollStateCache.load(key)
    const hasTarget = saved !== undefined && saved > 0

    let rafId = 0
    let cancelled = false
    // Cleared to save on cleanup only once we've applied the target (or there's
    // nothing to protect). While a positive target is pending, a cleanup must not
    // overwrite it with the clamped-to-0 scrollTop of an unsized scroller.
    let restored = !hasTarget

    if (hasTarget) {
      const start = performance.now()
      const tryRestore = () => {
        if (cancelled) return
        const el = getScrollElement()
        if (el) {
          // `scrollTop = saved` clamps to the element's current scroll range, so
          // it reads back as `saved` only once a range large enough exists (or
          // immediately in a no-layout test environment). Until then, keep
          // retrying across frames while content streams in and the pane sizes.
          el.scrollTop = saved
          if (el.scrollTop === saved) {
            restored = true
            return
          }
        }
        if (performance.now() - start < RESTORE_WINDOW_MS) {
          rafId = requestAnimationFrame(tryRestore)
        }
      }
      tryRestore()
    }

    return () => {
      cancelled = true
      if (rafId) cancelAnimationFrame(rafId)
      // Re-resolve on cleanup: the element captured on mount may have been
      // swapped (e.g. crossing the virtualization threshold) during the view's
      // lifetime, so read the current scroller's position at unmount time.
      const current = getScrollElement()
      if (current && restored) ScrollStateCache.save(key, current.scrollTop)
    }
    // getScrollElement is expected to be stable (reads from a ref); keyed only on
    // `key` so a key change saves the old view and restores the new one.
  }, [key])
}
