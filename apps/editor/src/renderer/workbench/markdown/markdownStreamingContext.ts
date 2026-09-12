/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Marks the subtree of a streaming agent message whose content is still growing.
 *
 *  A thought storm re-renders the growing tail ~60x/s, and anything expensive in
 *  that subtree is redone every frame. On 2026-09-12 that pushed a renderer from
 *  1195MB to 2300MB of working set in 35 seconds — ~800MB of it outside the V8
 *  heap, i.e. the DOM and its layout objects from re-tokenized code fences.
 *  Consumers skip that work while the flag is set and do it once on seal.
 *
 *  Lives apart from MarkdownView so MermaidBlock can consume it without a cycle.
 *--------------------------------------------------------------------------------------------*/

import { createContext, useContext } from 'react'

export const MarkdownStreamingContext = createContext(false)

export function useMarkdownStreaming(): boolean {
  return useContext(MarkdownStreamingContext)
}
