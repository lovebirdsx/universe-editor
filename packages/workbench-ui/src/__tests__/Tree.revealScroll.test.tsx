/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tree.revealScroll — revealing a row moves the tree's own scroller, nothing else.
 *
 *  Reveal used to call `el.scrollIntoView({ block: 'nearest' })`. That walks up
 *  *every* scrollable ancestor and scrolls each of them, and `overflow: hidden`
 *  does not exempt a box — script can still scroll it. Selecting a row in a
 *  sidebar list could therefore also shift an outer container (or the document),
 *  moving the view as a whole while the region the compositor had already
 *  rastered stayed put: the two frames landed on top of each other as
 *  double-exposed rows.
 *
 *  The tree now derives the minimal scroll from row geometry and assigns it to
 *  its own scroller, so no ancestor can move — and `scrollIntoView` is never
 *  called at all.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { Tree } from '../tree/Tree.js'
import { TreeModel } from '../tree/TreeModel.js'
import type { ITreeDataSource } from '../tree/ITreeDataSource.js'

interface Node {
  id: string
}

const ROW_HEIGHT = 22
/** happy-dom has no layout engine, so the viewport height is pinned by hand. */
const VIEWPORT = 220

function makeModel(count: number): TreeModel<Node> {
  const roots: Node[] = Array.from({ length: count }, (_, i) => ({ id: `r${i}` }))
  const dataSource: ITreeDataSource<Node> = {
    getId: (n) => n.id,
    hasChildren: () => false,
    getChildren: () => [],
    getRoots: () => roots,
  }
  return new TreeModel<Node>({ dataSource })
}

/** The tree scrolls inside an ancestor scroller — reveal must leave that one alone. */
function renderTree(model: TreeModel<Node>) {
  render(
    <div data-testid="outer" style={{ overflow: 'auto' }}>
      <Tree<Node>
        model={model}
        rowHeight={ROW_HEIGHT}
        renderRow={(ctx) => (
          <div key={ctx.node.id} data-row-key={ctx.node.id} style={ctx.style}>
            {ctx.node.id}
          </div>
        )}
      />
    </div>,
  )
  const root = screen.getByRole('tree')
  Object.defineProperty(root, 'clientHeight', { value: VIEWPORT, configurable: true })
  return { root, outer: screen.getByTestId('outer') }
}

const reveal = async (model: TreeModel<Node>, id: string): Promise<void> => {
  await act(async () => {
    model.setSelection([id], id)
  })
}

let scrollIntoViewSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  // spyOn (not a direct assignment) so the file-wide `restoreAllMocks` below
  // really puts the original back.
  scrollIntoViewSpy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('Tree — reveal scrolls only its own scroller', () => {
  it('scrolls down just enough to expose a row below the viewport', async () => {
    const model = makeModel(40)
    const { root } = renderTree(model)

    // Row 20 spans [440, 462); the viewport is [0, 220) → bottom-align it.
    await reveal(model, 'r20')

    expect(root.scrollTop).toBe(440 + ROW_HEIGHT - VIEWPORT)
  })

  it('scrolls up to a row above the viewport, and no further', async () => {
    const model = makeModel(40)
    const { root } = renderTree(model)
    root.scrollTop = 300

    // Row 2 spans [44, 66), above the viewport → top-align it.
    await reveal(model, 'r2')

    expect(root.scrollTop).toBe(44)
  })

  it('leaves the position untouched when the row is already visible', async () => {
    const model = makeModel(40)
    const { root } = renderTree(model)
    root.scrollTop = 100

    // Row 6 spans [132, 154) ⊂ [100, 320) — scrolling would be gratuitous movement.
    await reveal(model, 'r6')

    expect(root.scrollTop).toBe(100)
  })

  it('does not scroll when the revealed id is not a visible row', async () => {
    const model = makeModel(40)
    const { root } = renderTree(model)
    root.scrollTop = 100

    await reveal(model, 'nope')

    expect(root.scrollTop).toBe(100)
  })

  it('top-aligns the row when there is no viewport to align to', async () => {
    // A pane collapsed to zero height (or a pre-layout mount) has no "nearest"
    // edge, and nothing re-runs the reveal once the pane is sized — leaving the
    // request unconsumed would strand the row off-screen after expanding.
    const model = makeModel(40)
    const { root } = renderTree(model)
    Object.defineProperty(root, 'clientHeight', { value: 0, configurable: true })

    await reveal(model, 'r20')

    expect(root.scrollTop).toBe(440)
  })

  it('never calls scrollIntoView — it would drag every ancestor scroller along', async () => {
    const model = makeModel(40)
    const { root, outer } = renderTree(model)
    outer.scrollTop = 50

    await reveal(model, 'r20')

    expect(scrollIntoViewSpy).not.toHaveBeenCalled()
    // The ancestor scroller belongs to another view; moving it shifts the whole
    // layout and leaves the already-rastered region behind.
    expect(outer.scrollTop).toBe(50)
    expect(root.scrollTop).toBe(440 + ROW_HEIGHT - VIEWPORT)
  })
})
