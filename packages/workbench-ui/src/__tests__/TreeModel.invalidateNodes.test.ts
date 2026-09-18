/*---------------------------------------------------------------------------------------------
 *  TreeModel.invalidateNodes — what a view calls when rows disappear from the
 *  data source (a removed recent workspace, a forgotten host). The cursor must
 *  land on the row that took the removed row's place, never on a dangling id:
 *  navigate() reads a missing id as "nothing focused" and jumps to the first row.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { TreeModel } from '../tree/TreeModel.js'
import type { ITreeDataSource } from '../tree/ITreeDataSource.js'

interface Node {
  readonly id: string
}

const PARENT: Node = { id: 'parent' }
const CHILD: Node = { id: 'child' }

function makeModel(
  roots: Node[],
  children: Record<string, Node[]> = {},
  defaultExpanded?: (node: Node) => boolean,
) {
  const dataSource: ITreeDataSource<Node> = {
    getId: (n) => n.id,
    hasChildren: (n) => (children[n.id]?.length ?? 0) > 0,
    getChildren: (n) => children[n.id] ?? [],
    getRoots: () => roots,
  }
  const model = new TreeModel<Node>({
    dataSource,
    ...(defaultExpanded ? { defaultExpanded } : {}),
  })
  return {
    model,
    setRoots: (next: Node[]) => {
      roots = next
    },
    setChildren: (id: string, next: Node[]) => {
      children = { ...children, [id]: next }
    },
  }
}

describe('TreeModel.invalidateNodes', () => {
  it('hands the cursor to the row that slid into the removed row’s place', () => {
    const roots = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    const { model } = makeModel(roots)
    model.setSelection(['b'], 'b')

    model.invalidateNodes(['b'])

    expect(model.focused).toBe('c')
    // The row highlight follows the selection, so the successor has to be
    // selected too — a dangling focus renders as no cursor at all.
    expect(model.selection).toEqual(['c'])
  })

  it('keeps a multi-selection’s shape, with the successor in the removed seat', () => {
    const { model } = makeModel([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }])
    model.setSelection(['b', 'c'], 'b')

    model.invalidateNodes(['b'])

    expect(model.selection).toEqual(['c'])
    expect(model.focused).toBe('c')
  })

  it('moves the focus without selecting it when the cursor was outside the selection', () => {
    const { model } = makeModel([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }])
    model.setSelection(['a'], 'c')

    model.invalidateNodes(['c'])

    expect(model.focused).toBe('d')
    expect(model.selection).toEqual(['a'])
  })

  it('clamps to the new last row when the focused row was the last one', () => {
    const { model } = makeModel([{ id: 'a' }, { id: 'b' }])
    model.setSelection(['b'], 'b')

    model.invalidateNodes(['b'])

    expect(model.focused).toBe('a')
  })

  it('follows the focused row when a row above it disappears', () => {
    const { model } = makeModel([{ id: 'a' }, { id: 'b' }, { id: 'c' }])
    model.setSelection(['c'], 'c')

    model.invalidateNodes(['a'])

    expect(model.focused).toBe('c')
  })

  it('keeps the selection of rows that are still there', () => {
    const { model } = makeModel([{ id: 'a' }, { id: 'b' }])
    model.setSelection(['a', 'b'], 'a')

    model.invalidateNodes(['b'])

    expect(model.selection).toEqual(['a'])
    expect(model.focused).toBe('a')
  })

  it('leaves the cursor null when everything is gone', () => {
    const { model } = makeModel([{ id: 'a' }])
    model.setSelection(['a'], 'a')

    model.invalidateNodes(['a'])

    expect(model.focused).toBeNull()
  })

  it('emits one structure event and one selection event', () => {
    const { model } = makeModel([{ id: 'a' }, { id: 'b' }])
    model.setSelection(['a'], 'a')
    const onStructure = vi.fn()
    const onSelection = vi.fn()
    model.onDidChangeStructure(onStructure)
    model.onDidChangeSelection(onSelection)

    model.invalidateNodes(['a'])

    expect(onStructure).toHaveBeenCalledTimes(1)
    expect(onSelection).toHaveBeenCalledTimes(1)
  })

  it('emits no selection event when nothing selected disappeared', () => {
    const { model } = makeModel([{ id: 'a' }, { id: 'b' }])
    model.setSelection(['a'], 'a')
    const onSelection = vi.fn()
    model.onDidChangeSelection(onSelection)

    model.invalidateNodes(['b'])

    expect(onSelection).not.toHaveBeenCalled()
  })

  it('drops cached expansion so a returning row starts from the default again', async () => {
    const harness = makeModel([PARENT], { parent: [CHILD] }, () => false)
    await harness.model.expand(PARENT)
    expect(harness.model.isExpanded('parent')).toBe(true)

    harness.setRoots([])
    harness.model.invalidateNodes(['parent'])
    expect(harness.model.hasState('parent')).toBe(false)

    harness.setRoots([PARENT])
    expect(harness.model.isExpanded('parent')).toBe(false)
  })

  it('is a plain refresh when nothing was removed', () => {
    const { model } = makeModel([PARENT], { parent: [CHILD] }, () => true)
    const onStructure = vi.fn()
    model.onDidChangeStructure(onStructure)

    model.invalidateNodes([])

    expect(onStructure).toHaveBeenCalledTimes(1)
    expect(model.getVisibleNodes().map((n) => n.id)).toEqual(['parent', 'child'])
  })

  it('keeps neighbours from nested levels, not just the flat roots', () => {
    const harness = makeModel([PARENT], { parent: [{ id: 'x' }, { id: 'y' }] }, () => true)
    // The view rendered the old rows, so the visible cache describes the tree as
    // it was — that is what the neighbour is picked from.
    expect(harness.model.getVisibleNodes().map((n) => n.id)).toEqual(['parent', 'x', 'y'])
    harness.model.setSelection(['x'], 'x')

    harness.setChildren('parent', [{ id: 'y' }])
    harness.model.invalidateNodes(['x'])

    expect(harness.model.focused).toBe('y')
  })

  it('drops the cursor when the removed row was not on screen', () => {
    // Collapsed ancestor: the focused row is real but not in the visible list, so
    // there is no row that slid into its place. Guessing the first row would be
    // the same jump this method exists to prevent.
    const harness = makeModel([PARENT], { parent: [CHILD] }, () => false)
    harness.model.setSelection(['child'], 'child')
    expect(harness.model.getVisibleNodes().map((n) => n.id)).toEqual(['parent'])

    harness.setChildren('parent', [])
    harness.model.invalidateNodes(['child'])

    expect(harness.model.focused).toBeNull()
    expect(harness.model.selection).toEqual([])
  })

  it('ids that are not in the tree are ignored', () => {
    const { model } = makeModel([{ id: 'a' }, { id: 'b' }])
    model.setSelection(['b'], 'b')

    model.invalidateNodes(['nope'])

    expect(model.focused).toBe('b')
  })
})
