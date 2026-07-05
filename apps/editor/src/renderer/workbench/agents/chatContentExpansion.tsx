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

import { createContext, useContext } from 'react'

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
