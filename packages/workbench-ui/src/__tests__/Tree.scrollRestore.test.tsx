/*---------------------------------------------------------------------------------------------
 *  Regression: expanding / collapsing a folder must not jump the viewport.
 *
 *  Tree used to swap its scroll container when the visible-row count crossed
 *  `virtualizationThreshold` — the root div owned the scrollbar below it, the
 *  VirtualList's inner div above it. The new container started at scrollTop 0,
 *  so a user scrolled far down a large tree saw the viewport snap to the top
 *  every time a click pushed the row count over (or back under) the threshold.
 *  In the reported case a workspace sat around 181 rows: expanding a 30-file
 *  folder crossed 200, collapsing it crossed back, and each click jumped.
 *
 *  Two invariants now make that structurally impossible, and these tests pin
 *  both: the scroll container is always the `role="tree"` element (never
 *  swapped), and the threshold only decides whether every row is rendered or
 *  just the visible window. Carrying the position across the crossing is no
 *  longer a mechanism that can fail — there is nothing to carry it between.
 *
 *  happy-dom stores scrollTop as a plain property (no clamping), which is what
 *  makes the position directly assertable here.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { Tree } from '../tree/Tree.js'
import { TreeModel } from '../tree/TreeModel.js'
import type { ITreeDataSource } from '../tree/ITreeDataSource.js'

interface Node {
  id: string
  children?: Node[]
}

const THRESHOLD = 200
const ROW_HEIGHT = 22

/**
 * `leafCount` roots plus one folder holding `folderChildren`. Collapsed the
 * tree shows leafCount + 1 rows; expanded it also shows the folder's children,
 * so the two counts are chosen to straddle THRESHOLD.
 */
function makeModel(leafCount: number, folderChildren: number) {
  const folder: Node = {
    id: 'folder',
    children: Array.from({ length: folderChildren }, (_, i) => ({ id: `f${i}` })),
  }
  const roots: Node[] = [
    ...Array.from({ length: leafCount }, (_, i) => ({ id: `leaf${i}` })),
    folder,
  ]
  const dataSource: ITreeDataSource<Node> = {
    getId: (n) => n.id,
    hasChildren: (n) => !!n.children && n.children.length > 0,
    getChildren: (n) => n.children ?? [],
    getRoots: () => roots,
  }
  return { model: new TreeModel<Node>({ dataSource }), folder }
}

function renderTree(model: TreeModel<Node>) {
  return render(
    <Tree<Node>
      model={model}
      virtualizationThreshold={THRESHOLD}
      rowHeight={ROW_HEIGHT}
      renderRow={(ctx) => (
        <div key={ctx.node.id} data-row-key={ctx.node.id} style={ctx.style}>
          {ctx.node.id}
        </div>
      )}
    />,
  )
}

const rowCount = (container: HTMLElement): number =>
  container.querySelectorAll('[data-row-key]').length

const spacerHeight = (container: HTMLElement): number => {
  const spacer = container.querySelector<HTMLElement>('div[style*="position: relative"]')
  return spacer ? parseInt(spacer.style.height, 10) : -1
}

/**
 * Any element inside the tree that scrolls on its own. Must always be empty:
 * a nested scroller means the position lives somewhere React can unmount, which
 * is the whole failure mode being guarded against.
 */
const nestedScrollers = (container: HTMLElement): HTMLElement[] =>
  Array.from(container.querySelectorAll<HTMLElement>('[role="tree"] *')).filter((el) =>
    /auto|scroll/.test(el.style.overflowY || el.style.overflow),
  )

describe('Tree — scroll position survives crossing the windowing threshold', () => {
  // No globals/setup file in this package, so RTL's auto-cleanup is off and
  // trees from earlier cases would otherwise still be in the document.
  afterEach(cleanup)

  it('keeps the same scroll container and position when expanding past the threshold', async () => {
    // 190 leaves + folder = 191 rows; expanded = 221, crossing THRESHOLD.
    const { model, folder } = makeModel(190, 30)
    const { container } = renderTree(model)

    const root = screen.getByRole('tree')
    expect(nestedScrollers(container)).toEqual([])
    root.scrollTop = 777

    await act(async () => {
      await model.expand(folder)
    })

    // Same element, not merely an element with the same position: the previous
    // design replaced this node, which is what lost the position.
    expect(screen.getByRole('tree')).toBe(root)
    expect(nestedScrollers(container)).toEqual([])
    expect(root.scrollTop).toBe(777)
    expect(spacerHeight(container)).toBe(221 * ROW_HEIGHT)
  })

  it('keeps the same scroll container and position when collapsing back under it', async () => {
    const { model, folder } = makeModel(190, 30)
    const { container } = renderTree(model)

    await act(async () => {
      await model.expand(folder)
    })

    const root = screen.getByRole('tree')
    expect(nestedScrollers(container)).toEqual([])
    root.scrollTop = 300

    act(() => {
      model.collapse(folder)
    })

    expect(screen.getByRole('tree')).toBe(root)
    expect(nestedScrollers(container)).toEqual([])
    expect(root.scrollTop).toBe(300)
    expect(spacerHeight(container)).toBe(191 * ROW_HEIGHT)
  })

  it('renders every row below the threshold', () => {
    // Keeps small trees fully queryable (and keeps the views' own tests working
    // in happy-dom, which has no layout engine for a windowed list to measure).
    const { model } = makeModel(190, 30)
    const { container } = renderTree(model)

    expect(rowCount(container)).toBe(191)
  })

  it('windows the rows above the threshold', async () => {
    const { model, folder } = makeModel(190, 30)
    const { container } = renderTree(model)

    await act(async () => {
      await model.expand(folder)
    })

    // happy-dom reports a zero-height viewport, so the window is ~0 rows; the
    // point is that it is no longer all 221 while the spacer still spans them.
    expect(rowCount(container)).toBeLessThan(221)
    expect(spacerHeight(container)).toBe(221 * ROW_HEIGHT)
  })
})
