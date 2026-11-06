/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Pure document-symbol tree helpers shared by the Outline view and the
 *  breadcrumb symbol picker. Keeping the sort/build/prune logic here prevents
 *  the two surfaces from drifting (a symbol sorted one way in the sidebar and
 *  another way in the picker).
 *--------------------------------------------------------------------------------------------*/

import type { monaco } from '../editor/monaco/MonacoLoader.js'

export interface OutlineNode {
  readonly id: string
  readonly symbol: monaco.languages.DocumentSymbol
  readonly children: OutlineNode[]
}

export type OutlineSortOrder = 'position' | 'name' | 'kind'

export function compareOutlinePosition(
  a: monaco.languages.DocumentSymbol,
  b: monaco.languages.DocumentSymbol,
): number {
  return (
    a.range.startLineNumber - b.range.startLineNumber || a.range.startColumn - b.range.startColumn
  )
}

export function compareOutlineSymbols(
  a: monaco.languages.DocumentSymbol,
  b: monaco.languages.DocumentSymbol,
  order: OutlineSortOrder,
): number {
  if (order === 'name') return a.name.localeCompare(b.name) || compareOutlinePosition(a, b)
  if (order === 'kind') return a.kind - b.kind || a.name.localeCompare(b.name)
  return compareOutlinePosition(a, b)
}

// Markdown heading symbols keep their `#` markup in the name (e.g. `## Title`).
// The outline renders a `#` glyph for headings, so the leading markup is
// redundant — strip it for display only, leaving the underlying symbol intact.
export function displaySymbolName(name: string, languageId: string | undefined): string {
  return languageId === 'markdown' ? name.replace(/^#{1,6}\s+/, '') : name
}

export function buildOutlineNodes(
  roots: readonly monaco.languages.DocumentSymbol[],
  order: OutlineSortOrder,
): { roots: OutlineNode[]; idBySymbol: Map<monaco.languages.DocumentSymbol, string> } {
  const idBySymbol = new Map<monaco.languages.DocumentSymbol, string>()
  const build = (
    symbols: readonly monaco.languages.DocumentSymbol[],
    prefix: string,
  ): OutlineNode[] =>
    [...symbols]
      .sort((a, b) => compareOutlineSymbols(a, b, order))
      .map((symbol, i) => {
        const id = prefix === '' ? `${i}` : `${prefix}/${i}`
        idBySymbol.set(symbol, id)
        return { id, symbol, children: build(symbol.children ?? [], id) }
      })
  return { roots: build(roots, ''), idBySymbol }
}

export function outlineAncestorIds(id: string): string[] {
  const parts = id.split('/')
  const out: string[] = []
  for (let i = 1; i < parts.length; i++) out.push(parts.slice(0, i).join('/'))
  return out
}

export function collectOutlineExpandableIds(
  nodes: readonly OutlineNode[],
  acc: string[] = [],
): string[] {
  for (const n of nodes) {
    if (n.children.length > 0) {
      acc.push(n.id)
      collectOutlineExpandableIds(n.children, acc)
    }
  }
  return acc
}

/** Flatten the tree into an id → node map (for the parent-link lookup). */
export function indexOutlineNodes(
  nodes: readonly OutlineNode[],
  acc: Map<string, OutlineNode> = new Map(),
): Map<string, OutlineNode> {
  for (const n of nodes) {
    acc.set(n.id, n)
    indexOutlineNodes(n.children, acc)
  }
  return acc
}

/** Prune the tree to nodes that match `q` or have a matching descendant. */
export function pruneOutlineTree(nodes: readonly OutlineNode[], q: string): OutlineNode[] {
  const out: OutlineNode[] = []
  for (const n of nodes) {
    const children = pruneOutlineTree(n.children, q)
    if (n.symbol.name.toLowerCase().includes(q) || children.length > 0) {
      out.push({ id: n.id, symbol: n.symbol, children })
    }
  }
  return out
}

/** Collect ids of every node whose name matches `q`. */
export function collectOutlineMatchedIds(
  nodes: readonly OutlineNode[],
  q: string,
  acc: Set<string> = new Set(),
): Set<string> {
  for (const n of nodes) {
    if (n.symbol.name.toLowerCase().includes(q)) acc.add(n.id)
    collectOutlineMatchedIds(n.children, q, acc)
  }
  return acc
}
