/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ViewBody — the wrapper every rendered view sits in, at all three locations.
 *
 *  Besides tagging the subtree with `data-view-id` (how FocusStackService and
 *  the `focusedView` context key attribute focus to a view), it registers itself
 *  as the view's *fallback* focus target. That makes every view focusable by
 *  construction rather than by each view remembering to call useViewFocusable:
 *  views with no focusable content (MCP Servers, Output) and views that render
 *  an empty state before their tree exists (Timeline, Commit Changes, Session
 *  Changes) used to leave focus stranded on the Part, so they never entered the
 *  Ctrl+Tab recency list and could not be switched back to.
 *--------------------------------------------------------------------------------------------*/

import { useCallback, useRef, type CSSProperties, type ReactNode } from 'react'
import { useViewFocusable } from '../useViewFocusable.js'

interface Props {
  viewId: string
  className?: string | undefined
  style?: CSSProperties | undefined
  children: ReactNode
}

export function ViewBody({ viewId, className, style, children }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  useViewFocusable(
    viewId,
    useCallback(() => ref.current, []),
    { fallback: true },
  )

  return (
    <div
      ref={ref}
      data-view-id={viewId}
      // Programmatically focusable only: views own their own tab order, this is
      // just somewhere for focus to land when the view offers nothing better.
      tabIndex={-1}
      className={className}
      style={style}
    >
      {children}
    </div>
  )
}
