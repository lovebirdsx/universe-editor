/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  useTransformFreePlacement — places a `position: fixed` panel at real viewport
 *  coordinates, capped to the viewport, kept in sync while things move around it.
 *  Shared by the context-menu submenu panels and the SCM title overflow menu.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react'
import type { IViewportSize } from './anchorLayout.js'

/** Keep-away margin from the viewport edges, matching `AnchoredSurface`'s padding. */
const VIEWPORT_MARGIN = 8

export interface IPlacementOrigin {
  readonly top: number
  readonly left: number
}

export interface ITransformFreePlacement<T> {
  /** Whatever `compute` returned, so callers can read extras such as a direction. */
  readonly placement: T | undefined
  /** Apply verbatim to the panel's `style`; hides it until the first measurement. */
  readonly style: CSSProperties
}

const HIDDEN_STYLE: CSSProperties = { top: 0, left: 0, visibility: 'hidden' }

/**
 * `compute` receives the panel's rendered size and the viewport, and returns the
 * desired viewport position. It must be referentially stable (wrap it in
 * `useCallback`) — the panel re-measures whenever it changes.
 *
 * Two things this handles that a plain `getBoundingClientRect()` does not:
 *
 * A `transform` / `will-change: transform` ancestor — which Floating UI puts on
 * every surface root — becomes the containing block for `fixed` descendants, so
 * viewport coordinates would land offset by that ancestor's own origin. The
 * origin is recovered as `measured position − currently applied offset` and
 * subtracted back out (the same correction as VSCode's `menu.ts`).
 *
 * And the panel follows its surroundings: it re-measures on window resize and on
 * any ancestor scrolling, so a panel hanging off a row inside a scrollable menu
 * does not stay behind when that row moves.
 */
export function useTransformFreePlacement<T extends IPlacementOrigin>(
  ref: RefObject<HTMLElement | null>,
  compute: (panel: IViewportSize, viewport: IViewportSize) => T,
): ITransformFreePlacement<T> {
  const [placed, setPlaced] = useState<
    { readonly placement: T; readonly style: CSSProperties } | undefined
  >(undefined)

  const measure = useCallback(() => {
    const el = ref.current
    if (!el) return
    const win = el.ownerDocument.defaultView
    const viewport = { width: win?.innerWidth ?? 0, height: win?.innerHeight ?? 0 }

    // Cap before measuring so the height fed to `compute` is the one the panel
    // actually renders at; a taller-than-viewport panel then scrolls inside its
    // own box instead of spilling past the bottom edge. The cap goes into the
    // returned style too — this imperative set is only for this measurement, and
    // leaving React unaware of the property would make it stick by accident.
    const maxHeight = Math.max(0, viewport.height - 2 * VIEWPORT_MARGIN)
    el.style.maxHeight = `${maxHeight}px`

    // Read the applied offset back off the element rather than tracking it: this
    // is the ground truth even when several measurements run before React
    // re-renders.
    const appliedTop = parseFloat(el.style.top) || 0
    const appliedLeft = parseFloat(el.style.left) || 0
    const box = el.getBoundingClientRect()
    const originTop = box.top - appliedTop
    const originLeft = box.left - appliedLeft

    const placement = compute({ width: box.width, height: box.height }, viewport)
    const top = placement.top - originTop
    const left = placement.left - originLeft
    setPlaced((prev) =>
      prev?.style.top === top && prev.style.left === left && prev.style.maxHeight === maxHeight
        ? prev
        : { placement, style: { top, left, maxHeight } },
    )
  }, [ref, compute])

  useLayoutEffect(() => {
    measure()
    const win = ref.current?.ownerDocument.defaultView
    if (!win) return
    win.addEventListener('resize', measure)
    // Capture phase: scroll events do not bubble, so this is the only way to see
    // an arbitrary ancestor scrolling.
    win.addEventListener('scroll', measure, true)
    return () => {
      win.removeEventListener('resize', measure)
      win.removeEventListener('scroll', measure, true)
    }
  }, [ref, measure])

  return placed ?? { placement: undefined, style: HIDDEN_STYLE }
}
