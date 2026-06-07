/*---------------------------------------------------------------------------------------------
 *  Tests for the DocumentSymbol tree queries in markdownSymbols.ts.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import type { monaco } from '../../../../workbench/editor/monaco/MonacoLoader.js'
import { findSymbolAtLine, symbolAncestryPath } from '../markdownSymbols.js'

const KIND = 14 as monaco.languages.SymbolKind // SymbolKind.String

/** Build a DocumentSymbol spanning [startLine, endLine] (1-based) with children. */
function sym(
  name: string,
  startLine: number,
  endLine: number,
  children: monaco.languages.DocumentSymbol[] = [],
): monaco.languages.DocumentSymbol {
  const range = { startLineNumber: startLine, startColumn: 1, endLineNumber: endLine, endColumn: 1 }
  return {
    name,
    detail: '',
    kind: KIND,
    tags: [],
    range,
    selectionRange: { ...range, endLineNumber: startLine },
    children,
  }
}

describe('findSymbolAtLine', () => {
  // A [1..10] { A.1 [3..5] }, B [6..10]
  const roots = [sym('A', 1, 5, [sym('A.1', 3, 5)]), sym('B', 6, 10)]

  it('returns the deepest containing symbol', () => {
    expect(findSymbolAtLine(roots, 4)?.name).toBe('A.1')
  })

  it('returns the parent when the line is in its own (non-child) region', () => {
    expect(findSymbolAtLine(roots, 2)?.name).toBe('A')
  })

  it('returns the later sibling', () => {
    expect(findSymbolAtLine(roots, 7)?.name).toBe('B')
  })

  it('returns undefined when no symbol contains the line', () => {
    expect(findSymbolAtLine(roots, 99)).toBeUndefined()
  })
})

describe('symbolAncestryPath', () => {
  const child = sym('A.1', 3, 5)
  const roots = [sym('A', 1, 5, [child])]

  it('returns the path from root to target', () => {
    expect(symbolAncestryPath(roots, child).map((s) => s.name)).toEqual(['A', 'A.1'])
  })

  it('returns an empty path for an undefined target', () => {
    expect(symbolAncestryPath(roots, undefined)).toEqual([])
  })
})
