/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tree queries over a Monaco DocumentSymbol list, used by the Outline view and
 *  Breadcrumbs to locate the active symbol and its ancestry. The symbol tree
 *  itself now comes from the markdown language server; these helpers only walk
 *  it. Kept free of any runtime Monaco dependency (only `import type`).
 *--------------------------------------------------------------------------------------------*/

import type { monaco } from '../../../workbench/editor/monaco/MonacoLoader.js'

/** Deepest symbol whose range contains the 1-based line number, if any. */
export function findSymbolAtLine(
  roots: readonly monaco.languages.DocumentSymbol[],
  lineNumber: number,
): monaco.languages.DocumentSymbol | undefined {
  let found: monaco.languages.DocumentSymbol | undefined
  const visit = (syms: readonly monaco.languages.DocumentSymbol[]): void => {
    for (const s of syms) {
      if (lineNumber >= s.range.startLineNumber && lineNumber <= s.range.endLineNumber) {
        found = s
        if (s.children) visit(s.children)
      }
    }
  }
  visit(roots)
  return found
}

/** Path of symbols from a root down to `target` (inclusive), by identity. */
export function symbolAncestryPath(
  roots: readonly monaco.languages.DocumentSymbol[],
  target: monaco.languages.DocumentSymbol | undefined,
): readonly monaco.languages.DocumentSymbol[] {
  if (!target) return []
  const path: monaco.languages.DocumentSymbol[] = []
  const dfs = (syms: readonly monaco.languages.DocumentSymbol[]): boolean => {
    for (const s of syms) {
      path.push(s)
      if (s === target) return true
      if (s.children && dfs(s.children)) return true
      path.pop()
    }
    return false
  }
  dfs(roots)
  return path
}
