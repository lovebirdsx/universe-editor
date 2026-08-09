/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Content-expansion store — persists the *inner* expand/collapse state of a card
 *  (a long user message clamped by max-height, an execute tool call's terminal
 *  output) across unmount → remount cycles (session switch, editor tab switch,
 *  virtualization scroll-off). ChatBody owns the store (folded into
 *  AcpChatViewStateCache alongside the outer per-slot collapse overrides); the
 *  leaf components read/write it through this context, keyed by a stable card key.
 *  Absent (null) for standalone use (ToolCallList) → leaf falls back to local state.
 *--------------------------------------------------------------------------------------------*/

import { createContext, useContext, useLayoutEffect, useRef, type RefObject } from 'react'

export interface ContentExpansionStore {
  /** Keys whose inner content the user has expanded. Absent key ⇒ collapsed. */
  readonly expandedKeys: ReadonlySet<string>
  toggle(key: string): void
}

const ContentExpansionContext = createContext<ContentExpansionStore | null>(null)

export const ContentExpansionProvider = ContentExpansionContext.Provider

export function useContentExpansion(): ContentExpansionStore | null {
  return useContext(ContentExpansionContext)
}

/**
 * Scrolls the clamped card back into view when its inner content collapses.
 * The expand/collapse toggle is sticky at the scrollport bottom, so the user
 * can collapse a long card from deep inside it — the row then shrinks by
 * thousands of pixels and, without this, the viewport lands on unrelated
 * content far below the card (the virtualizer only compensates for rows
 * entirely above the viewport).
 */
export function useRevealOnCollapse(
  ref: RefObject<HTMLElement | null>,
  expanded: boolean,
  clamps: boolean,
): void {
  const prevExpanded = useRef(expanded)
  useLayoutEffect(() => {
    const was = prevExpanded.current
    prevExpanded.current = expanded
    if (was && !expanded && clamps) ref.current?.scrollIntoView({ block: 'nearest' })
  }, [ref, expanded, clamps])
}
