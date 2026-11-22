/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Tree.stickyScroll — the pinned ancestor stack. Geometry comes from the
 *  tree's own scroller (happy-dom has no layout engine, so the viewport height
 *  is pinned by hand), the chain from visible depths, and the stack must stay a
 *  presentation-only copy: no `data-row-key`, no focusable content.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Tree } from '../tree/Tree.js'
import { TreeModel, type IVisibleNode } from '../tree/TreeModel.js'
import type { ITreeDataSource } from '../tree/ITreeDataSource.js'

interface Node {
  id: string
}

const ROW_HEIGHT = 22
const VIEWPORT = 220

/** root → A → B → f0..f9, everything expanded: 13 visible rows. */
function makeModel(): TreeModel<Node> {
  const children = new Map<string, Node[]>([
    ['root', [{ id: 'A' }]],
    ['A', [{ id: 'B' }]],
    ['B', Array.from({ length: 10 }, (_, i) => ({ id: `f${i}` }))],
  ])
  const dataSource: ITreeDataSource<Node> = {
    getId: (n) => n.id,
    hasChildren: (n) => (children.get(n.id)?.length ?? 0) > 0,
    getChildren: (n) => children.get(n.id) ?? [],
    getRoots: () => [{ id: 'root' }],
    getParent: (n) => {
      for (const [parentId, kids] of children) {
        if (kids.some((kid) => kid.id === n.id)) return { id: parentId }
      }
      return null
    },
  }
  return new TreeModel<Node>({ dataSource, defaultExpanded: () => true })
}

interface RenderOptions {
  sticky?: boolean
  maxStickyRows?: number
  getRowHeight?: (node: IVisibleNode<Node>) => number | undefined
}

function renderTree(model: TreeModel<Node>, options: RenderOptions = {}) {
  render(
    <Tree<Node>
      model={model}
      rowHeight={ROW_HEIGHT}
      {...(options.maxStickyRows !== undefined ? { maxStickyRows: options.maxStickyRows } : {})}
      {...(options.getRowHeight !== undefined ? { getRowHeight: options.getRowHeight } : {})}
      {...(options.sticky === false
        ? {}
        : {
            renderStickyRow: (ctx: { node: IVisibleNode<Node>; indentPadding: number }) => (
              <div data-sticky-key={ctx.node.id} style={{ paddingLeft: ctx.indentPadding }}>
                {ctx.node.id}
              </div>
            ),
          })}
      renderRow={(ctx) => (
        <div data-row-key={ctx.node.id} style={ctx.style}>
          {ctx.node.id}
        </div>
      )}
    />,
  )
  const root = screen.getByRole('tree')
  Object.defineProperty(root, 'clientHeight', { value: VIEWPORT, configurable: true })
  return root
}

/** Sticky measurement is rAF-throttled; the callback scheduled here runs first. */
const flush = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(resolve))
  })
}

const scrollTo = async (root: HTMLElement, top: number): Promise<void> => {
  root.scrollTop = top
  root.dispatchEvent(new Event('scroll'))
  await flush()
}

const reveal = async (model: TreeModel<Node>, id: string): Promise<void> => {
  await act(async () => {
    model.setSelection([id], id)
  })
}

const stickyLabels = (): string[] =>
  [...document.querySelectorAll<HTMLElement>('[data-testid="tree-sticky-row"]')].map(
    (row) => row.textContent ?? '',
  )

afterEach(cleanup)

describe('Tree — sticky scroll', () => {
  it('pins nothing while the tree is at the top', async () => {
    const model = makeModel()
    const root = renderTree(model)

    await flush()
    await scrollTo(root, 0)

    expect(stickyLabels()).toEqual([])
    model.dispose()
  })

  it('pins the ancestor chain of the row at the viewport top edge', async () => {
    const model = makeModel()
    const root = renderTree(model)
    await flush()

    // Row 5 is f2 (depth 3): its ancestors are A, B and the workspace root.
    await scrollTo(root, 5 * ROW_HEIGHT)

    expect(stickyLabels()).toEqual(['root', 'A', 'B'])
    model.dispose()
  })

  it('shifts the pinned chain as the top row changes', async () => {
    const model = makeModel()
    const root = renderTree(model)
    await flush()

    await scrollTo(root, ROW_HEIGHT)
    expect(stickyLabels()).toEqual(['root'])

    await scrollTo(root, 3 * ROW_HEIGHT)
    expect(stickyLabels()).toEqual(['root', 'A', 'B'])
    model.dispose()
  })

  it('keeps the innermost scopes when the stack is capped', async () => {
    const model = makeModel()
    const root = renderTree(model, { maxStickyRows: 2 })
    await flush()

    await scrollTo(root, 5 * ROW_HEIGHT)

    expect(stickyLabels()).toEqual(['A', 'B'])
    model.dispose()
  })

  it('scrolls the clicked pinned row below the stack, not onto the top edge', async () => {
    const model = makeModel()
    const root = renderTree(model)
    await flush()
    await scrollTo(root, 5 * ROW_HEIGHT)

    const pinnedA = [...document.querySelectorAll<HTMLElement>('[data-sticky-key]')].find(
      (row) => row.dataset['stickyKey'] === 'A',
    )
    expect(pinnedA).toBeDefined()
    fireEvent.click(pinnedA!)

    // A's real row sits just below the pinned root; top-aligning it (22) would
    // hide it under the 22px stack.
    expect(root.scrollTop).toBe(0)
    model.dispose()
  })

  it('reveals a row above the viewport below the pinned band', async () => {
    const model = makeModel()
    const root = renderTree(model)
    await flush()
    // Top edge is f2 (depth 3): the band is root + A + B = 66px.
    await scrollTo(root, 5 * ROW_HEIGHT)

    // f0 spans [66, 88); top-aligning it would put it under the 66px band.
    await reveal(model, 'f0')

    expect(root.scrollTop).toBe(0)
    model.dispose()
  })

  it('reveals a row that is already inside the pinned band', async () => {
    const model = makeModel()
    const root = renderTree(model)
    await flush()
    // Band covers [110, 176): f3 ([132, 154)) is on screen but hidden.
    await scrollTo(root, 5 * ROW_HEIGHT)

    await reveal(model, 'f3')

    // Top-align f3 just below the band at the new top edge (f0, band 66).
    expect(root.scrollTop).toBe(3 * ROW_HEIGHT)
    model.dispose()
  })

  it('recomputes the band when a deeper subtree sits above the target', async () => {
    // root → A → { B → f0..f9, C }: C is shallow, but the row above the landing
    // spot is a deep descendant of B, so its band is taller than C's ancestors.
    const children = new Map<string, Node[]>([
      ['root', [{ id: 'A' }]],
      ['A', [{ id: 'B' }, { id: 'C' }]],
      ['B', Array.from({ length: 10 }, (_, i) => ({ id: `f${i}` }))],
    ])
    const dataSource: ITreeDataSource<Node> = {
      getId: (n) => n.id,
      hasChildren: (n) => (children.get(n.id)?.length ?? 0) > 0,
      getChildren: (n) => children.get(n.id) ?? [],
      getRoots: () => [{ id: 'root' }],
    }
    const model = new TreeModel<Node>({ dataSource, defaultExpanded: () => true })
    const root = renderTree(model)
    await flush()
    await scrollTo(root, 13 * ROW_HEIGHT)

    await reveal(model, 'C')

    // 242 reserves C's own 44px band, but the top row there (f8) pins 66px;
    // scrolling one row further (220) clears it.
    expect(root.scrollTop).toBe(10 * ROW_HEIGHT)
    model.dispose()
  })

  it('does not scroll when the row is already below the pinned band', async () => {
    const model = makeModel()
    const root = renderTree(model)
    Object.defineProperty(root, 'scrollHeight', {
      configurable: true,
      get: () => 13 * ROW_HEIGHT,
    })
    await flush()
    await scrollTo(root, 5 * ROW_HEIGHT)

    // f5 spans [176, 198), fully below the 66px band and inside [110, 330).
    await reveal(model, 'f5')

    expect(root.scrollTop).toBe(5 * ROW_HEIGHT)
    model.dispose()
  })

  it('shrinks the reserved band with maxStickyRows', async () => {
    const model = makeModel()
    const root = renderTree(model, { maxStickyRows: 2 })
    await flush()
    await scrollTo(root, 5 * ROW_HEIGHT)

    // With two pinned rows the band is A + B = 44, so f0 lands at 22.
    await reveal(model, 'f0')

    expect(root.scrollTop).toBe(ROW_HEIGHT)
    model.dispose()
  })

  it('reserves the band for per-row heights too', async () => {
    const heights = new Map<string, number>([
      ['root', 22],
      ['A', 40],
      ['B', 22],
      ['f0', 40],
      ['f1', 40],
      ['f2', 40],
      ['f3', 40],
      ['f4', 40],
      ['f5', 40],
      ['f6', 40],
      ['f7', 40],
      ['f8', 40],
      ['f9', 40],
      ['C', 40],
    ])
    const children = new Map<string, Node[]>([
      ['root', [{ id: 'A' }]],
      ['A', [{ id: 'B' }, { id: 'C' }]],
      ['B', Array.from({ length: 10 }, (_, i) => ({ id: `f${i}` }))],
    ])
    const dataSource: ITreeDataSource<Node> = {
      getId: (n) => n.id,
      hasChildren: (n) => (children.get(n.id)?.length ?? 0) > 0,
      getChildren: (n) => children.get(n.id) ?? [],
      getRoots: () => [{ id: 'root' }],
    }
    const model = new TreeModel<Node>({ dataSource, defaultExpanded: () => true })
    const root = renderTree(model, { getRowHeight: (node) => heights.get(node.id) })
    await flush()
    // C starts at 22 + 40 + 22 + 10 * 40 = 484.
    await scrollTo(root, 484)

    await reveal(model, 'C')

    // The band above C is A + root = 62; at 422 the top row (f8) pins 84, so
    // the landing spot is 400 (C top at 84, exactly the f-row band).
    expect(root.scrollTop).toBe(400)
    model.dispose()
  })

  it('retries against a laid-out viewport with sticky enabled', async () => {
    // The reveal's pre-layout retry must survive the band gate: a content-sized
    // clientHeight is not a viewport, so no band is reserved on the first try.
    const roots: Node[] = Array.from({ length: 40 }, (_, i) => ({ id: `r${i}` }))
    const dataSource: ITreeDataSource<Node> = {
      getId: (n) => n.id,
      hasChildren: () => false,
      getChildren: () => [],
      getRoots: () => roots,
    }
    const model = new TreeModel<Node>({ dataSource })
    const root = renderTree(model)
    let laidOut = false
    Object.defineProperty(root, 'clientHeight', {
      configurable: true,
      get: () => (laidOut ? VIEWPORT : 40 * ROW_HEIGHT),
    })
    Object.defineProperty(root, 'scrollHeight', {
      configurable: true,
      get: () => 40 * ROW_HEIGHT,
    })

    await reveal(model, 'r39')
    expect(root.scrollTop).toBe(0)

    laidOut = true
    await flush()

    expect(root.scrollTop).toBe(40 * ROW_HEIGHT - VIEWPORT)
    model.dispose()
  })

  it('renders a presentation-only copy: inert, and no duplicate row keys', async () => {
    const model = makeModel()
    const root = renderTree(model)
    await flush()
    await scrollTo(root, 5 * ROW_HEIGHT)

    const sticky = document.querySelectorAll('[data-testid="tree-sticky-row"]')
    expect(sticky.length).toBe(3)
    expect(
      document.querySelectorAll('[data-testid="tree-sticky-row"] [data-row-key]'),
    ).toHaveLength(0)
    for (const row of sticky) {
      expect(row.querySelector('[inert]')).not.toBeNull()
    }
    // The rows themselves still hold exactly one element per key.
    const rowKeys = [...root.querySelectorAll('[data-row-key]')].map((el) =>
      el.getAttribute('data-row-key'),
    )
    expect(new Set(rowKeys).size).toBe(rowKeys.length)
    model.dispose()
  })

  it('renders no pinned rows when the hook is not provided', async () => {
    const model = makeModel()
    const root = renderTree(model, { sticky: false })
    await flush()

    await scrollTo(root, 5 * ROW_HEIGHT)

    expect(document.querySelectorAll('[data-testid="tree-sticky-row"]')).toHaveLength(0)
    model.dispose()
  })
})
