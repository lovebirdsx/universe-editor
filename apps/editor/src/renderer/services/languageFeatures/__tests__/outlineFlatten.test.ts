/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/languageFeatures/outlineFlatten.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import type { monaco } from '../../../workbench/editor/monaco/MonacoLoader.js'
import { flattenOutline } from '../outlineFlatten.js'

function sym(
  name: string,
  children: monaco.languages.DocumentSymbol[] = [],
): monaco.languages.DocumentSymbol {
  return {
    name,
    detail: '',
    kind: 14 as monaco.languages.SymbolKind,
    tags: [],
    range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
    selectionRange: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 },
    children,
  }
}

describe('flattenOutline', () => {
  it('returns [] for empty roots', () => {
    expect(flattenOutline([])).toEqual([])
  })

  it('walks the tree in pre-order with correct depth', () => {
    const tree = [sym('A', [sym('A1'), sym('A2', [sym('A2a')])]), sym('B')]
    const flat = flattenOutline(tree)
    expect(flat.map((f) => f.symbol.name)).toEqual(['A', 'A1', 'A2', 'A2a', 'B'])
    expect(flat.map((f) => f.depth)).toEqual([0, 1, 1, 2, 0])
  })

  it('assigns unique stable path ids', () => {
    const tree = [sym('A', [sym('A1')]), sym('B')]
    const flat = flattenOutline(tree)
    const ids = flat.map((f) => f.id)
    expect(ids).toEqual(['0', '0/0', '1'])
    expect(new Set(ids).size).toBe(ids.length)
  })
})
