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
}

function renderTree(model: TreeModel<Node>, options: RenderOptions = {}) {
  render(
    <Tree<Node>
      model={model}
      rowHeight={ROW_HEIGHT}
      {...(options.maxStickyRows !== undefined ? { maxStickyRows: options.maxStickyRows } : {})}
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

  it('scrolls back to the pinned row when it is clicked', async () => {
    const model = makeModel()
    const root = renderTree(model)
    await flush()
    await scrollTo(root, 5 * ROW_HEIGHT)

    const pinnedA = [...document.querySelectorAll<HTMLElement>('[data-sticky-key]')].find(
      (row) => row.dataset['stickyKey'] === 'A',
    )
    expect(pinnedA).toBeDefined()
    fireEvent.click(pinnedA!)

    expect(root.scrollTop).toBe(ROW_HEIGHT)
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
