/*---------------------------------------------------------------------------------------------
 *  Tests for GridLayout — the React renderer for a Grid<T> binary tree.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { Direction, Grid, Orientation, type IGridView } from '@universe-editor/platform'
import { GridLayout } from '../layout/GridLayout.js'

class TestView implements IGridView {
  readonly minimumWidth = 50
  readonly maximumWidth = Number.POSITIVE_INFINITY
  readonly minimumHeight = 50
  readonly maximumHeight = Number.POSITIVE_INFINITY
  constructor(readonly viewId: string) {}
}

function makeGrid() {
  const a = new TestView('a')
  const b = new TestView('b')
  return { a, b }
}

// Capture every live ResizeObserver so a test can fire its callback on demand,
// standing in for the layout notification happy-dom never emits.
const observers: Array<() => void> = []

class FakeResizeObserver {
  constructor(private readonly cb: () => void) {
    observers.push(this.cb)
  }
  observe() {}
  unobserve() {}
  disconnect() {
    const i = observers.indexOf(this.cb)
    if (i !== -1) observers.splice(i, 1)
  }
}

let RealResizeObserver: typeof ResizeObserver | undefined

beforeEach(() => {
  RealResizeObserver = globalThis.ResizeObserver
  ;(globalThis as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver
})

afterEach(() => {
  cleanup()
  observers.length = 0
  if (RealResizeObserver) globalThis.ResizeObserver = RealResizeObserver
})

/**
 * Stand in for a laid-out container: stub the root branch's box, then fire the
 * ResizeObserver callback the way a real resize would.
 */
function reportContainer(container: HTMLElement, size: { width: number; height: number }): void {
  const root = container.querySelector<HTMLElement>('.grid-branch')!
  Object.defineProperty(root, 'offsetWidth', { value: size.width, configurable: true })
  Object.defineProperty(root, 'offsetHeight', { value: size.height, configurable: true })
  act(() => {
    for (const cb of [...observers]) cb()
  })
}

function dragSash(sash: Element, fromPx: number, toPx: number, vertical = true): void {
  const from = vertical ? { clientX: fromPx } : { clientY: fromPx }
  const to = vertical ? { clientX: toPx } : { clientY: toPx }
  fireEvent.mouseDown(sash, from)
  fireEvent.mouseMove(window, to)
  fireEvent.mouseUp(window)
}

function rootBranchEl(container: HTMLElement): HTMLElement {
  return container.querySelector<HTMLElement>('.grid-branch')!
}

/** The separator a branch owns, i.e. the one between its own children. */
function ownSash(branchEl: Element): Element {
  const sash = [...branchEl.children].find((child) => child.getAttribute('role') === 'separator')
  if (!sash) throw new Error('branch has no sash')
  return sash
}

function nestedBranchEl(branchEl: Element): HTMLElement {
  const nested = [...branchEl.children].find((child) => child.classList.contains('grid-branch'))
  if (!nested) throw new Error('branch has no nested branch')
  return nested as HTMLElement
}

describe('GridLayout — structural rendering', () => {
  it('renders a single panel without a sash for a single-leaf grid', () => {
    const { a } = makeGrid()
    const grid = new Grid(a)
    const { container } = render(
      <GridLayout grid={grid} viewFactory={(v) => <span data-view={v.viewId} />} />,
    )
    expect(container.querySelectorAll('.grid-leaf').length).toBe(1)
    expect(container.querySelectorAll('[role="separator"]').length).toBe(0)
  })

  it('renders two panels with one vertical sash after split right', () => {
    const { a, b } = makeGrid()
    const grid = new Grid(a)
    grid.addView(b, 100, a, Direction.Right)
    const { container } = render(
      <GridLayout grid={grid} viewFactory={(v) => <span data-view={v.viewId} />} />,
    )
    expect(container.querySelectorAll('.grid-leaf').length).toBe(2)
    const sashes = container.querySelectorAll('[role="separator"]')
    expect(sashes.length).toBe(1)
    expect(sashes[0]!.getAttribute('aria-orientation')).toBe('vertical')
  })

  it('renders two panels with one horizontal sash after split down', () => {
    const { a, b } = makeGrid()
    const grid = new Grid(a)
    grid.addView(b, 100, a, Direction.Down)
    const { container } = render(
      <GridLayout grid={grid} viewFactory={(v) => <span data-view={v.viewId} />} />,
    )
    expect(container.querySelectorAll('.grid-leaf').length).toBe(2)
    const sashes = container.querySelectorAll('[role="separator"]')
    expect(sashes.length).toBe(1)
    expect(sashes[0]!.getAttribute('aria-orientation')).toBe('horizontal')
  })

  it('renders three panels with two sashes after two right splits', () => {
    const a = new TestView('a')
    const b = new TestView('b')
    const c = new TestView('c')
    const grid = new Grid(a)
    grid.addView(b, 100, a, Direction.Right)
    grid.addView(c, 100, b, Direction.Right)
    const { container } = render(
      <GridLayout grid={grid} viewFactory={(v) => <span data-view={v.viewId} />} />,
    )
    expect(container.querySelectorAll('.grid-leaf').length).toBe(3)
    expect(container.querySelectorAll('[role="separator"]').length).toBe(2)
  })
})

describe('GridLayout — equal-size split', () => {
  it('two panels after split right have equal flex-grow values', () => {
    const { a, b } = makeGrid()
    const grid = new Grid(a)
    grid.addView(b, 100, a, Direction.Right)
    const { container } = render(
      <GridLayout grid={grid} viewFactory={(v) => <span data-view={v.viewId} />} />,
    )
    const leaves = container.querySelectorAll<HTMLElement>('.grid-leaf')
    expect(leaves.length).toBe(2)
    const flexA = leaves[0]!.style.flex
    const flexB = leaves[1]!.style.flex
    // Both panels should report the same flex-grow (equal sizes from addView)
    expect(flexA).toBe(flexB)
  })

  it('two panels after split down have equal flex-grow values', () => {
    const { a, b } = makeGrid()
    const grid = new Grid(a)
    grid.addView(b, 100, a, Direction.Down)
    const { container } = render(
      <GridLayout grid={grid} viewFactory={(v) => <span data-view={v.viewId} />} />,
    )
    const leaves = container.querySelectorAll<HTMLElement>('.grid-leaf')
    expect(leaves.length).toBe(2)
    const flexA = leaves[0]!.style.flex
    const flexB = leaves[1]!.style.flex
    expect(flexA).toBe(flexB)
  })
})

describe('GridLayout — sash drag resizes in pixel units', () => {
  function renderTwoColumns() {
    const { a, b } = makeGrid()
    const grid = new Grid(a)
    grid.addView(b, 100, a, Direction.Right)
    const { container } = render(
      <GridLayout grid={grid} viewFactory={(v) => <span data-view={v.viewId} />} />,
    )
    reportContainer(container, { width: 1000, height: 600 })
    return { a, b, grid, container }
  }

  /** Root(H)[ V( H(A,B), C ), D ] — a tree `addView` cannot express. */
  function renderNested() {
    const v = {
      a: new TestView('a'),
      b: new TestView('b'),
      c: new TestView('c'),
      d: new TestView('d'),
    }
    const leaf = (data: keyof typeof v) => ({ type: 'leaf' as const, size: 500, data })
    const grid = new Grid(v.a)
    grid.rebuildFrom(
      {
        type: 'branch',
        size: 1,
        orientation: Orientation.Horizontal,
        children: [
          {
            type: 'branch',
            size: 500,
            orientation: Orientation.Vertical,
            children: [
              {
                type: 'branch',
                size: 500,
                orientation: Orientation.Horizontal,
                children: [leaf('a'), leaf('b')],
              },
              leaf('c'),
            ],
          },
          leaf('d'),
        ],
      },
      (data) => v[data as keyof typeof v],
    )
    const { container } = render(
      <GridLayout grid={grid} viewFactory={(view) => <span data-view={view.viewId} />} />,
    )
    reportContainer(container, { width: 1000, height: 600 })
    return { grid, v, container }
  }

  it('dragging the sash 50px right on a 1000px container grows the left panel by 50px', () => {
    const { a, b, grid, container } = renderTwoColumns()

    dragSash(container.querySelector('[role="separator"]')!, 500, 550)

    expect(grid.getViewSize(a)?.width).toBeCloseTo(550)
    expect(grid.getViewSize(b)?.width).toBeCloseTo(450)
  })

  it('grid fires onDidChange after sash drag', () => {
    const { grid, container } = renderTwoColumns()
    const spy = vi.fn()
    grid.onDidChange(spy)

    dragSash(container.querySelector('[role="separator"]')!, 400, 460)

    expect(spy).toHaveBeenCalled()
  })

  it('applies the same pixel step after the container is re-reported at double size', () => {
    const { a, grid, container } = renderTwoColumns()

    dragSash(container.querySelector('[role="separator"]')!, 0, 50)
    expect(grid.getViewSize(a)!.width).toBeCloseTo(550)

    reportContainer(container, { width: 2000, height: 600 })
    const beforeSecond = grid.getViewSize(a)!.width
    expect(beforeSecond).toBeCloseTo(1100) // the same flex ratio, twice the box

    dragSash(container.querySelector('[role="separator"]')!, 0, 50)

    // Pixel steps are container-independent; only the flex weight they map to varies.
    expect(grid.getViewSize(a)!.width).toBeCloseTo(beforeSecond + 50)
  })

  it('dragging before any container size is reported changes nothing', () => {
    const { a, b } = makeGrid()
    const grid = new Grid(a)
    grid.addView(b, 100, a, Direction.Right)
    const { container } = render(
      <GridLayout grid={grid} viewFactory={(v) => <span data-view={v.viewId} />} />,
    )
    const before = grid.getLeafSize(a)

    expect(() => dragSash(container.querySelector('[role="separator"]')!, 0, 50)).not.toThrow()

    expect(grid.getLeafSize(a)).toBe(before)
  })

  it('moves the split the sash belongs to, not an inner one', () => {
    // Root(H)[ V( H(A,B), C ), D ] — the V|D and the A|B splits are both
    // horizontal, so resolving the sash through its leftmost leaf (A) would
    // move A|B instead.
    const { grid, v, container } = renderNested()
    expect(grid.getViewSize(v.a)).toEqual({ width: 250, height: 300 })

    const rootEl = rootBranchEl(container)
    dragSash(ownSash(rootEl), 0, 50)

    expect(grid.getViewSize(v.d)?.width).toBeCloseTo(450) // D gave up space…
    expect(grid.getViewSize(v.a)?.width).toBeCloseTo(275) // …to the whole V column
    expect(grid.getViewSize(v.a)?.height).toBeCloseTo(300) // heights untouched
    expect(grid.getViewSize(v.c)?.height).toBeCloseTo(300)
  })

  it('resizes the inner split when its own sash is dragged', () => {
    const { grid, v, container } = renderNested()

    dragSash(ownSash(nestedBranchEl(rootBranchEl(container))), 0, 50, false)

    expect(grid.getViewSize(v.a)?.height).toBeCloseTo(350)
    expect(grid.getViewSize(v.c)?.height).toBeCloseTo(250)
    expect(grid.getViewSize(v.d)?.width).toBeCloseTo(500) // the V|D split is untouched
    expect(grid.getViewSize(v.a)?.width).toBeCloseTo(250)
  })
})
