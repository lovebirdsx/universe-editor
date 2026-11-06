/*---------------------------------------------------------------------------------------------
 *  Tests for workbench/editor/breadcrumbs/symbolPickerModel.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import type { monaco } from '../../../editor/monaco/MonacoLoader.js'
import type { OutlineModel } from '../../../../services/languageFeatures/editorOutlineTracker.js'
import {
  createSymbolPickerDataSource,
  createSymbolPickerSnapshot,
  toOutlineSortOrder,
} from '../symbolPickerModel.js'

function symbol(
  name: string,
  kind: number,
  line: number,
  children: monaco.languages.DocumentSymbol[] = [],
): monaco.languages.DocumentSymbol {
  const range = { startLineNumber: line, startColumn: 1, endLineNumber: line + 5, endColumn: 1 }
  return {
    name,
    detail: '',
    kind: kind as monaco.languages.SymbolKind,
    tags: [],
    range,
    selectionRange: range,
    children,
  }
}

function outline(roots: monaco.languages.DocumentSymbol[]): OutlineModel {
  return { uri: 'file:///ws/a.ts', roots, languageId: 'typescript', version: 1 }
}

describe('createSymbolPickerSnapshot', () => {
  const a1 = symbol('a1', 12, 11)
  const a = symbol('a', 11, 10, [a1])
  const b = symbol('b', 12, 1)
  const model = outline([b, a])

  it('maps the active symbol to its tree id and expands its ancestors', () => {
    const snapshot = createSymbolPickerSnapshot(model, a1, 'position')
    expect(snapshot.initialId).toBe(snapshot.idBySymbol.get(a1))
    expect(snapshot.ancestorIds).toEqual([snapshot.idBySymbol.get(a)])
    expect(snapshot.idBySymbol.get(a)).toBe('1')
  })

  it('falls back to the first root without an active symbol', () => {
    const snapshot = createSymbolPickerSnapshot(model, undefined, 'position')
    expect(snapshot.initialId).toBe('0')
    expect(snapshot.nodeById.get('0')?.symbol).toBe(b)
  })

  it('sorts roots and children by position, name and kind', () => {
    expect(
      createSymbolPickerSnapshot(model, undefined, 'position').roots.map((n) => n.symbol.name),
    ).toEqual(['b', 'a'])

    expect(
      createSymbolPickerSnapshot(model, undefined, 'name').roots.map((n) => n.symbol.name),
    ).toEqual(['a', 'b'])

    const byType = createSymbolPickerSnapshot(model, undefined, 'type')
    expect(byType.roots.map((n) => n.symbol.kind)).toEqual([11, 12])
  })

  it('maps the type sort order to the outline kind order', () => {
    expect(toOutlineSortOrder('type')).toBe('kind')
    expect(toOutlineSortOrder('name')).toBe('name')
    expect(toOutlineSortOrder('position')).toBe('position')
  })

  it('returns an empty id set for a symbol from another outline', () => {
    const snapshot = createSymbolPickerSnapshot(model, symbol('alien', 1, 1), 'position')
    expect(snapshot.initialId).toBe('0')
  })
})

describe('createSymbolPickerDataSource', () => {
  const a1 = symbol('a1', 12, 2)
  const a = symbol('a', 11, 1, [a1])
  const b = symbol('b', 12, 10)
  const snapshot = createSymbolPickerSnapshot(outline([a, b]), a1, 'position')
  const dataSource = createSymbolPickerDataSource(snapshot)

  it('exposes the snapshot tree', () => {
    expect(dataSource.getRoots().map((n) => n.symbol.name)).toEqual(['a', 'b'])
    const root = dataSource.getRoots()[0]!
    expect(dataSource.getId(root)).toBe('0')
    expect(dataSource.hasChildren(root)).toBe(true)
    expect(dataSource.getChildren(root)?.map((n) => n.symbol.name)).toEqual(['a1'])
    expect(dataSource.hasChildren(dataSource.getChildren(root)![0]!)).toBe(false)
  })

  it('resolves parents through the id path', () => {
    const root = dataSource.getRoots()[0]!
    const child = dataSource.getChildren(root)![0]!
    expect(dataSource.getParent!(child)).toBe(root)
    expect(dataSource.getParent!(root)).toBeNull()
  })
})
