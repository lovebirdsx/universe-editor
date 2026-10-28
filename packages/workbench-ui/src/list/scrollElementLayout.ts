/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  A virtualizer must not measure its scroll element before the browser has laid
 *  the frame out. View containers remount their view (Explorer included), and
 *  Allotment only sizes a pane on a later layout tick; until then a `height:100%`
 *  scroller resolves to `auto`, so `clientHeight` reports the *content* height.
 *  Handing that number to the virtualizer renders every row at once — thousands
 *  of DOM nodes inserted synchronously on a container switch.
 *
 *  A real viewport can never be taller than the window that contains it, so an
 *  element claiming to be taller is pre-layout. `0` is not trusted either: a list
 *  can mount empty and grow its content before the pane is sized.
 *--------------------------------------------------------------------------------------------*/

import { useLayoutEffect, useRef, useState } from 'react'
import {
  cancelOwnerFrame,
  getOwnerResizeObserver,
  getOwnerWindow,
  requestOwnerFrame,
  type OwnerFrame,
} from '../dom/ownerWindow.js'

/** Matches useScrollRestore's window: long enough for an async pane layout. */
const TRUST_WINDOW_MS = 1000

export function hasTrustworthyViewport(element: HTMLElement): boolean {
  const docHeight = element.ownerDocument?.documentElement?.clientHeight ?? 0
  // No layout engine (happy-dom) or a document that was never laid out: every
  // measurement is meaningless, so there is nothing to gate on. Blocking here
  // would leave windowed lists permanently empty in tests. A real renderer
  // reports the viewport height here, even before any content is mounted.
  if (docHeight <= 0) return true
  const win = getOwnerWindow(element)
  const limit = Math.max(win?.innerHeight ?? 0, docHeight)
  const height = element.clientHeight
  return height > 0 && height <= limit
}

/**
 * Returns whether `resolve()`'s scroll element can be measured yet. While false
 * the caller must keep the element away from the virtualizer (null scroll
 * element) and must not read its virtual items: reading them seeds the
 * virtualizer's scroll offset from the pre-restore `scrollTop`, and the delayed
 * attach would write that stale offset back over a restored position.
 */
export function useTrustedScrollElement(
  resolve: () => HTMLElement | null,
  enabled: boolean,
): boolean {
  const [trusted, setTrusted] = useState(false)
  // Only the first attach needs the gate: once the virtualizer has measured a
  // trustworthy element (even from the non-windowed path, which never reads
  // virtual items), detaching on a later threshold crossing would make the
  // delayed re-attach write back a stale cached offset and lose the live scroll
  // position. A non-windowed mount in a pre-layout pane is not that case — its
  // measurement is the content height, so crossing the threshold must still gate.
  const passedRef = useRef(false)

  useLayoutEffect(() => {
    if (enabled || passedRef.current) return
    const element = resolve()
    if (element !== null && hasTrustworthyViewport(element)) passedRef.current = true
  }, [enabled, resolve])

  useLayoutEffect(() => {
    if (!enabled || passedRef.current || trusted) return
    let cancelled = false
    let frame: OwnerFrame | undefined
    let observer: ResizeObserver | undefined
    let observed: HTMLElement | null = null

    const check = (): void => {
      if (cancelled) return
      const element = resolve()
      if (element !== null) {
        if (hasTrustworthyViewport(element)) {
          setTrusted(true)
          return
        }
        if (observed !== element) {
          observer?.disconnect()
          observed = element
          const Ctor = getOwnerResizeObserver(element)
          if (Ctor) {
            // A pane being sized changes this box, so the first RO callback is
            // the fastest signal that the viewport is real.
            observer = new Ctor(check)
            observer.observe(element)
          }
        }
      }
      cancelOwnerFrame(frame)
      frame = requestOwnerFrame(element ?? undefined, check)
    }

    // A real timer, not a check inside `check`: when the window throttles or
    // suspends rAF there is no next check to notice the deadline, and the list
    // would stay empty until the window wakes up. Falling open after the window
    // is a deliberate trade — showing rows again beats hiding them forever.
    const timer = setTimeout(() => {
      if (!cancelled) setTrusted(true)
    }, TRUST_WINDOW_MS)

    check()
    return () => {
      cancelled = true
      clearTimeout(timer)
      observer?.disconnect()
      cancelOwnerFrame(frame)
    }
  }, [enabled, trusted, resolve])

  return !enabled || passedRef.current || trusted
}
