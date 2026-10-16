/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tree.visibleWindow — the `onVisibleNodesChange` viewport report.
 *
 *  Geometry is derived from the tree's own scroller, not from the virtualizer:
 *  in the non-windowed mode VirtualList renders every row and the virtualizer's
 *  total size is just the sum of `estimateSize`, so its window is not the
 *  viewport. These tests pin the report to real scroller geometry, the overscan
 *  slack, the de-dupe key and the zero-height rule.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { Tree } from '../tree/Tree.js'
import { TreeModel, type IVisibleNode } from '../tree/TreeModel.js'
import type { ITreeDataSource } from '../tree/ITreeDataSource.js'

interface Node {
  id: string
}

const ROW_HEIGHT = 22
/** happy-dom has no layout engine, so the viewport height is pinned by hand. */
const VIEWPORT = 220
const VIEWPORT_ROWS = VIEWPORT / ROW_HEIGHT
const OVERSCAN = 5

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

// Capture live ResizeObserver callbacks so a test can fire one on demand,
// standing in for the layout notification happy-dom never emits.
const resizeCallbacks: Array<() => void> = []

class FakeResizeObserver {
  constructor(private readonly cb: () => void) {
    resizeCallbacks.push(this.cb)
  }
  observe() {}
  unobserve() {}
  disconnect() {
    const i = resizeCallbacks.indexOf(this.cb)
    if (i !== -1) resizeCallbacks.splice(i, 1)
  }
}

let realResizeObserver: typeof ResizeObserver | undefined

beforeEach(() => {
  realResizeObserver = globalThis.ResizeObserver
  ;(globalThis as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver
})

afterEach(() => {
  cleanup()
  resizeCallbacks.length = 0
  if (realResizeObserver) globalThis.ResizeObserver = realResizeObserver
  vi.restoreAllMocks()
})

interface RenderOptions {
  onVisible?: (nodes: readonly IVisibleNode<Node>[]) => void
  getRowHeight?: (node: IVisibleNode<Node>) => number | undefined
  viewport?: number
}

function renderTree(model: TreeModel<Node>, options: RenderOptions = {}) {
  const view = render(
    <Tree<Node>
      model={model}
      rowHeight={ROW_HEIGHT}
      {...(options.getRowHeight ? { getRowHeight: options.getRowHeight } : {})}
      {...(options.onVisible ? { onVisibleNodesChange: options.onVisible } : {})}
      renderRow={(ctx) => (
        <div key={ctx.node.id} data-row-key={ctx.node.id} style={ctx.style}>
          {ctx.node.id}
        </div>
      )}
    />,
  )
  const root = screen.getByRole('tree')
  Object.defineProperty(root, 'clientHeight', {
    value: options.viewport ?? VIEWPORT,
    configurable: true,
  })
  return { root, view }
}

/**
 * The first report is deferred a frame (so it reads settled layout), so every
 * assertion waits one rAF — the tree's callback was scheduled before the one
 * awaited here and therefore runs first.
 */
const flushWindow = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(resolve))
  })
}

const scrollTo = async (root: HTMLElement, top: number): Promise<void> => {
  root.scrollTop = top
  root.dispatchEvent(new Event('scroll'))
  await flushWindow()
}

const reportIds = (spy: ReturnType<typeof vi.fn>, call = -1): string[] => {
  const nodes = spy.mock.calls.at(call)?.[0] as readonly IVisibleNode<Node>[] | undefined
  return nodes?.map((n) => n.id) ?? []
}

const expectedRange = (start: number, end: number): string[] =>
  Array.from({ length: end - start + 1 }, (_, i) => `r${start + i}`)

describe('Tree — visible-window report', () => {
  it('reports the viewport rows plus the overscan slack on mount', async () => {
    const onVisible = vi.fn()
    renderTree(makeModel(50), { onVisible })

    await flushWindow()

    expect(reportIds(onVisible)).toEqual(expectedRange(0, VIEWPORT_ROWS - 1 + OVERSCAN))
  })

  it('re-reports the shifted window when the viewport scrolls', async () => {
    const onVisible = vi.fn()
    const { root } = renderTree(makeModel(50), { onVisible })
    await flushWindow()

    await scrollTo(root, VIEWPORT)

    // Rows 10..19 are on screen; with slack the window is 5..24.
    expect(reportIds(onVisible)).toEqual(expectedRange(VIEWPORT_ROWS - OVERSCAN, 24))
  })

  it('clamps the window at both ends of the list', async () => {
    const onVisible = vi.fn()
    const { root } = renderTree(makeModel(20), { onVisible })
    await flushWindow()

    // Near the top: the leading slack is clamped to row 0.
    await scrollTo(root, 2 * ROW_HEIGHT)
    expect(reportIds(onVisible)[0]).toBe('r0')

    // At the bottom: the trailing slack is clamped to the last row.
    await scrollTo(root, 20 * ROW_HEIGHT - VIEWPORT)
    expect(reportIds(onVisible).at(-1)).toBe('r19')
  })

  it('does not re-report an unchanged window', async () => {
    const onVisible = vi.fn()
    const { root } = renderTree(makeModel(50), { onVisible })
    await flushWindow()
    expect(onVisible).toHaveBeenCalledTimes(1)

    // Same position: a scroll event that moves nothing must not re-fire.
    await scrollTo(root, 0)
    expect(onVisible).toHaveBeenCalledTimes(1)
  })

  it('re-reports after a structure change even when the index range is unchanged', async () => {
    const onVisible = vi.fn()
    const model = makeModel(50)
    renderTree(model, { onVisible })
    await flushWindow()
    expect(reportIds(onVisible)).toEqual(expectedRange(0, VIEWPORT_ROWS - 1 + OVERSCAN))

    await act(async () => {
      model.refresh()
    })
    await flushWindow()

    // Same range, different tree: the rows themselves may have changed under
    // the window, so it must be re-reported.
    expect(onVisible).toHaveBeenCalledTimes(2)
    expect(reportIds(onVisible)).toEqual(expectedRange(0, VIEWPORT_ROWS - 1 + OVERSCAN))
  })

  it('reports an empty window when the tree has no height, and recovers on resize', async () => {
    const onVisible = vi.fn()
    let laidOut = false
    const model = makeModel(50)
    const { root } = renderTree(model, { onVisible })
    Object.defineProperty(root, 'clientHeight', {
      configurable: true,
      get: () => (laidOut ? VIEWPORT : 0),
    })
    await flushWindow()
    // A hidden pane (clientHeight 0) covers no rows — nothing may be queried.
    expect(reportIds(onVisible)).toEqual([])

    // Coming back fires no scroll event; the ResizeObserver is the signal.
    // Every captured observer is fired because they are indistinguishable here
    // (the virtualizer observes the same scroller) and its own callback trips
    // over happy-dom's missing layout — irrelevant to the window report.
    laidOut = true
    await act(async () => {
      for (const cb of [...resizeCallbacks]) {
        try {
          cb()
        } catch {
          // the virtualizer's layout read, see above
        }
      }
      await new Promise((resolve) => requestAnimationFrame(resolve))
    })

    expect(reportIds(onVisible)).toEqual(expectedRange(0, VIEWPORT_ROWS - 1 + OVERSCAN))
  })

  it('accumulates per-row heights when getRowHeight is given', async () => {
    const onVisible = vi.fn()
    renderTree(makeModel(30), {
      onVisible,
      getRowHeight: (node) => (node.id === 'r0' ? 60 : ROW_HEIGHT),
    })

    await flushWindow()

    // Row 0 spans [0, 60); rows 1..8 follow at 22px, row 8 ending at 214 < 220.
    // Row 9 starts at 236, below the viewport — window = 0..8 plus slack → 0..13.
    expect(reportIds(onVisible)).toEqual(expectedRange(0, 13))
  })

  it('attaches no scroll listener when the prop is omitted', async () => {
    const spy = vi.spyOn(Element.prototype, 'addEventListener')
    const scrollListeners = (): number => spy.mock.calls.filter((c) => c[0] === 'scroll').length

    renderTree(makeModel(20))
    const without = scrollListeners()

    cleanup()
    spy.mockClear()

    renderTree(makeModel(20), { onVisible: vi.fn() })
    const withProp = scrollListeners()

    // A tree without the prop adds exactly one listener fewer than one with it —
    // both render the same VirtualList, so its own listener cancels out.
    expect(without).toBeGreaterThan(0)
    expect(withProp).toBe(without + 1)
  })

  it('re-reports the same window after the prop is detached and re-attached', async () => {
    const onVisible = vi.fn()
    const model = makeModel(20)
    const { view } = renderTree(model, { onVisible })
    await flushWindow()
    expect(onVisible).toHaveBeenCalledTimes(1)

    const rerenderWith = (cb: ((nodes: readonly IVisibleNode<Node>[]) => void) | undefined): void =>
      view.rerender(
        <Tree<Node>
          model={model}
          rowHeight={ROW_HEIGHT}
          {...(cb ? { onVisibleNodesChange: cb } : {})}
          renderRow={(ctx) => (
            <div key={ctx.node.id} data-row-key={ctx.node.id} style={ctx.style}>
              {ctx.node.id}
            </div>
          )}
        />,
      )

    // Detach: the effect tears down and must forget the last window, or the
    // re-attached callback would be suppressed by a stale de-dupe key and the
    // host would never learn which rows are visible.
    rerenderWith(undefined)
    await flushWindow()
    expect(onVisible).toHaveBeenCalledTimes(1)

    rerenderWith(onVisible)
    await flushWindow()
    expect(onVisible).toHaveBeenCalledTimes(2)
    expect(reportIds(onVisible)).toEqual(expectedRange(0, VIEWPORT_ROWS - 1 + OVERSCAN))
  })

  it('stops reporting after unmount', async () => {
    const onVisible = vi.fn()
    const { root, view } = renderTree(makeModel(50), { onVisible })
    await flushWindow()
    const calls = onVisible.mock.calls.length

    view.unmount()
    root.scrollTop = VIEWPORT
    root.dispatchEvent(new Event('scroll'))
    await flushWindow()

    expect(onVisible).toHaveBeenCalledTimes(calls)
  })

  it('does not re-report on selection changes', async () => {
    const onVisible = vi.fn()
    const model = makeModel(50)
    renderTree(model, { onVisible })
    await flushWindow()
    expect(onVisible).toHaveBeenCalledTimes(1)

    await act(async () => {
      model.setSelection(['r3'], 'r3')
    })
    await flushWindow()

    // Selection updates reach rows through props; the visible window is
    // structure-only, so nothing may be re-reported (and nothing re-queried).
    expect(onVisible).toHaveBeenCalledTimes(1)
  })
})
