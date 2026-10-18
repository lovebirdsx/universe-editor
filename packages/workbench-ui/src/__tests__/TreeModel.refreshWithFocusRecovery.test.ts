/*---------------------------------------------------------------------------------------------
 *  TreeModel.refreshWithFocusRecovery — views rebuild their data source and
 *  call refresh(); the cursor must not be left on a row that no longer exists
 *  (navigate() reads a missing id as "nothing focused" and jumps to row 0).
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { TreeModel } from '../tree/TreeModel.js'
import type { ITreeDataSource } from '../tree/ITreeDataSource.js'

interface Node {
  readonly id: string
}

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

describe('TreeModel.refreshWithFocusRecovery', () => {
  it('hands the cursor to the row that slid into the removed row’s place', () => {
    const harness = makeModel([{ id: 'a' }, { id: 'b' }, { id: 'c' }])
    harness.model.setSelection(['b'], 'b')

    harness.model.getVisibleNodes() // the view rendered the old rows
    harness.setRoots([{ id: 'a' }, { id: 'c' }])
    harness.model.refreshWithFocusRecovery()

    expect(harness.model.focused).toBe('c')
    // The highlight follows the selection, so the successor takes the seat.
    expect(harness.model.selection).toEqual(['c'])
  })

  it('clamps to the previous row when the last row disappeared', () => {
    const harness = makeModel([{ id: 'a' }, { id: 'b' }])
    harness.model.setSelection(['b'], 'b')

    harness.model.getVisibleNodes()
    harness.setRoots([{ id: 'a' }])
    harness.model.refreshWithFocusRecovery()

    expect(harness.model.focused).toBe('a')
    expect(harness.model.selection).toEqual(['a'])
  })

  it('counts every row removed above the focus when a range is deleted', () => {
    const harness = makeModel([
      { id: 'a' },
      { id: 'b' },
      { id: 'c' },
      { id: 'd' },
      { id: 'e' },
      { id: 'f' },
    ])
    harness.model.setSelection(['d'], 'd')

    harness.model.getVisibleNodes()
    // b..d were deleted together while the cursor sat on the last of them.
    harness.setRoots([{ id: 'a' }, { id: 'e' }, { id: 'f' }])
    harness.model.refreshWithFocusRecovery()

    expect(harness.model.focused).toBe('e')
    expect(harness.model.selection).toEqual(['e'])
  })

  it('keeps the cursor when the focused row survives', () => {
    const harness = makeModel([{ id: 'a' }, { id: 'b' }, { id: 'c' }])
    harness.model.setSelection(['b'], 'b')

    harness.setRoots([{ id: 'b' }, { id: 'c' }])
    harness.model.refreshWithFocusRecovery()

    expect(harness.model.focused).toBe('b')
    expect(harness.model.selection).toEqual(['b'])
  })

  it('prunes removed rows from the selection while the focus survives', () => {
    const harness = makeModel([{ id: 'a' }, { id: 'b' }, { id: 'c' }])
    harness.model.setSelection(['a', 'c'], 'c')

    harness.model.getVisibleNodes()
    harness.setRoots([{ id: 'c' }])
    harness.model.refreshWithFocusRecovery()

    expect(harness.model.focused).toBe('c')
    expect(harness.model.selection).toEqual(['c'])
  })

  it('keeps a multi-selection’s shape with the successor in the removed seat', () => {
    const harness = makeModel([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }])
    harness.model.setSelection(['b', 'd'], 'b')

    harness.model.getVisibleNodes()
    harness.setRoots([{ id: 'a' }, { id: 'c' }, { id: 'd' }])
    harness.model.refreshWithFocusRecovery()

    expect(harness.model.selection).toEqual(['c', 'd'])
    expect(harness.model.focused).toBe('c')
  })

  it('moves the focus without selecting it when the cursor was outside the selection', () => {
    const harness = makeModel([{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }])
    harness.model.setSelection(['a'], 'c')

    harness.model.getVisibleNodes()
    harness.setRoots([{ id: 'a' }, { id: 'b' }, { id: 'd' }])
    harness.model.refreshWithFocusRecovery()

    expect(harness.model.focused).toBe('d')
    expect(harness.model.selection).toEqual(['a'])
  })

  it('leaves the cursor null when the list became empty', () => {
    const harness = makeModel([{ id: 'a' }])
    harness.model.setSelection(['a'], 'a')

    harness.model.getVisibleNodes()
    harness.setRoots([])
    harness.model.refreshWithFocusRecovery()

    expect(harness.model.focused).toBeNull()
    expect(harness.model.selection).toEqual([])
  })

  it('does not guess a successor for a focus hidden under a collapsed ancestor', async () => {
    const parent: Node = { id: 'parent' }
    const child: Node = { id: 'child' }
    const harness = makeModel([parent], { parent: [child] }, () => false)
    harness.model.setSelection(['child'], 'child')
    expect(harness.model.getVisibleNodes().map((n) => n.id)).toEqual(['parent'])

    harness.model.getVisibleNodes()
    harness.setChildren('parent', [])
    harness.model.refreshWithFocusRecovery()

    expect(harness.model.focused).toBe('child')
  })

  it('does not clear expansion state, so a restored row keeps its fold', async () => {
    const parent: Node = { id: 'parent' }
    const child: Node = { id: 'child' }
    const harness = makeModel([parent], { parent: [child] })
    await harness.model.expand(parent)

    harness.model.getVisibleNodes()
    harness.setRoots([])
    harness.model.refreshWithFocusRecovery()
    expect(harness.model.isExpanded('parent')).toBe(true)

    harness.setRoots([parent])
    expect(harness.model.getVisibleNodes().map((n) => n.id)).toEqual(['parent', 'child'])
  })

  it('picks neighbours from nested levels, not just the flat roots', async () => {
    const parent: Node = { id: 'parent' }
    const x: Node = { id: 'x' }
    const y: Node = { id: 'y' }
    const harness = makeModel([parent], { parent: [x, y] }, () => true)
    expect(harness.model.getVisibleNodes().map((n) => n.id)).toEqual(['parent', 'x', 'y'])
    harness.model.setSelection(['x'], 'x')

    harness.model.getVisibleNodes()
    harness.setChildren('parent', [y])
    harness.model.refreshWithFocusRecovery()

    expect(harness.model.focused).toBe('y')
  })

  it('emits one structure event and one selection event when the focus moves', () => {
    const harness = makeModel([{ id: 'a' }, { id: 'b' }])
    harness.model.setSelection(['a'], 'a')
    const onStructure = vi.fn()
    const onSelection = vi.fn()
    harness.model.onDidChangeStructure(onStructure)
    harness.model.onDidChangeSelection(onSelection)

    harness.model.getVisibleNodes()
    harness.setRoots([{ id: 'b' }])
    harness.model.refreshWithFocusRecovery()

    expect(onStructure).toHaveBeenCalledTimes(1)
    expect(onSelection).toHaveBeenCalledTimes(1)
  })

  it('emits no selection event when the focus and selection survive', () => {
    const harness = makeModel([{ id: 'a' }, { id: 'b' }])
    harness.model.setSelection(['a'], 'a')
    const onStructure = vi.fn()
    const onSelection = vi.fn()
    harness.model.onDidChangeStructure(onStructure)
    harness.model.onDidChangeSelection(onSelection)

    harness.model.getVisibleNodes()
    harness.setRoots([{ id: 'a' }])
    harness.model.refreshWithFocusRecovery()

    expect(onStructure).toHaveBeenCalledTimes(1)
    expect(onSelection).not.toHaveBeenCalled()
  })

  it('is a plain refresh when nothing is selected or focused', () => {
    const harness = makeModel([{ id: 'a' }])
    const onStructure = vi.fn()
    harness.model.onDidChangeStructure(onStructure)

    harness.model.getVisibleNodes()
    harness.setRoots([{ id: 'b' }])
    harness.model.refreshWithFocusRecovery()

    expect(onStructure).toHaveBeenCalledTimes(1)
    expect(harness.model.focused).toBeNull()
  })
})
