/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AnchoredSurface — the single positioning primitive for coordinate-anchored popups
 *  (context menus, overflow menus, quick-settings, tooltips, …). Given a viewport
 *  point `{x, y}` it positions floating content with Floating UI so it never spills
 *  off-screen: `shift` slides it back into view along both axes (so a menu
 *  anchored below the cursor moves up rather than flipping to a cramped side),
 *  and `size` caps the height to the viewport. Rendered in a `FloatingPortal`,
 *  with optional click-outside + Escape dismissal wired through `onClose`.
 *
 *  This replaces the hand-written `style={{ top, left }}` + document listeners that
 *  each popup used to duplicate (and which had no off-screen handling).
 *--------------------------------------------------------------------------------------------*/

import { useEffect, type ReactNode } from 'react'
import {
  useFloating,
  autoUpdate,
  offset,
  shift,
  size,
  useDismiss,
  useInteractions,
  FloatingPortal,
  type Placement,
} from '@floating-ui/react'

export interface AnchoredSurfaceProps {
  /** Viewport point the surface is anchored to (e.g. click / caret coordinates). */
  readonly x: number
  readonly y: number
  /** Preferred side/alignment; Floating UI flips it when there isn't room. */
  readonly placement?: Placement
  /** Gap in px between the anchor point and the surface. */
  readonly offset?: number
  /** Keep-away margin from the viewport edges. */
  readonly padding?: number
  /** Called on click-outside or Escape. Omit to disable auto-dismissal. */
  readonly onClose?: () => void
  /** Extra props merged onto the floating element (className, role, style, …). */
  readonly surfaceProps?: React.HTMLAttributes<HTMLDivElement>
  readonly children: ReactNode
}

export function AnchoredSurface({
  x,
  y,
  placement = 'bottom-start',
  offset: offsetPx = 0,
  padding = 8,
  onClose,
  surfaceProps,
  children,
}: AnchoredSurfaceProps) {
  const { refs, floatingStyles, context } = useFloating({
    open: true,
    onOpenChange: (open) => {
      if (!open) onClose?.()
    },
    placement,
    strategy: 'fixed',
    whileElementsMounted: autoUpdate,
    middleware: [
      offset(offsetPx),
      // Cap the height to the whole viewport (not to the anchor→edge distance):
      // combined with cross-axis `shift` below, a menu that fits the viewport is
      // shown in full, and a scrollbar only appears when the menu is taller than
      // the viewport itself.
      size({
        padding,
        apply({ availableHeight, elements }) {
          const viewportHeight = elements.floating.ownerDocument.documentElement.clientHeight
          const cap = viewportHeight > 0 ? viewportHeight - 2 * padding : availableHeight
          Object.assign(elements.floating.style, {
            maxHeight: `${Math.max(0, cap)}px`,
          })
        },
      }),
      // No `flip`: instead of jumping to the opposite side (which can clip when
      // that side is also small), slide the whole surface along both axes to keep
      // it fully in view. `crossAxis: true` lets a menu anchored below the cursor
      // move up so it stays inside the viewport, using the full vertical space.
      shift({ mainAxis: true, crossAxis: true, padding }),
    ],
  })

  // Anchor to a zero-size virtual point at (x, y) in viewport coordinates.
  useEffect(() => {
    refs.setPositionReference({
      getBoundingClientRect: () => ({
        x,
        y,
        width: 0,
        height: 0,
        top: y,
        left: x,
        right: x,
        bottom: y,
      }),
    })
  }, [refs, x, y])

  const dismiss = useDismiss(context, {
    enabled: onClose !== undefined,
    outsidePressEvent: 'mousedown',
  })
  const { getFloatingProps } = useInteractions([dismiss])

  const { style: extraStyle, ...restSurfaceProps } = surfaceProps ?? {}

  return (
    <FloatingPortal>
      <div
        ref={refs.setFloating}
        style={{
          zIndex: 9999,
          display: 'flex',
          flexDirection: 'column',
          ...floatingStyles,
          ...extraStyle,
        }}
        {...getFloatingProps(restSurfaceProps)}
      >
        {children}
      </div>
    </FloatingPortal>
  )
}
