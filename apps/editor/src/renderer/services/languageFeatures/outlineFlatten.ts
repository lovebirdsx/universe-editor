/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Flattens a Monaco DocumentSymbol tree into a depth-tagged, document-order list
 *  for the Go to Symbol in Editor quick pick. Pure (only `import type` of monaco).
 *--------------------------------------------------------------------------------------------*/

import type { monaco } from '../../workbench/editor/monaco/MonacoLoader.js'

export interface FlatSymbol {
  /** Stable path id (e.g. "0/2/1"), unique within the tree. */
  readonly id: string
  readonly symbol: monaco.languages.DocumentSymbol
  readonly depth: number
}

/** Pre-order DFS; children follow their parent, preserving tree order. */
export function flattenOutline(
  roots: readonly monaco.languages.DocumentSymbol[],
): readonly FlatSymbol[] {
  const out: FlatSymbol[] = []
  const visit = (
    symbols: readonly monaco.languages.DocumentSymbol[],
    depth: number,
    prefix: string,
  ): void => {
    symbols.forEach((symbol, i) => {
      const id = prefix === '' ? `${i}` : `${prefix}/${i}`
      out.push({ id, symbol, depth })
      if (symbol.children && symbol.children.length > 0) visit(symbol.children, depth + 1, id)
    })
  }
  visit(roots, 0, '')
  return out
}
