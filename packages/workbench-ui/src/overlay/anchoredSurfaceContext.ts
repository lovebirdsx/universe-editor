/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Positioning handshake between `AnchoredSurface` and the `position: fixed`
 *  panels rendered inside it (`useTransformFreePlacement`).
 *--------------------------------------------------------------------------------------------*/

import { createContext } from 'react'

/**
 * Whether the enclosing `AnchoredSurface` has finished its first Floating UI
 * positioning pass.
 *
 * Floating UI computes asynchronously, so on the first commit the surface still
 * sits at `translate(0px, 0px)` and only moves to the anchor a tick later. A
 * `fixed` panel measured during that window reads both its parent row's rect
 * and its own containing-block origin from the un-translated surface, and — as
 * nothing re-fires when the transform lands — keeps the resulting offset
 * forever, ending up shifted off-screen by roughly the anchor coordinates.
 *
 * Defaults to `true`: panels rendered outside an `AnchoredSurface` (the SCM
 * title overflow menu portals straight to `document.body`) have no async
 * positioning phase to wait for.
 */
export const AnchoredSurfacePositionedContext = createContext(true)
