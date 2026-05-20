/*---------------------------------------------------------------------------------------------
 *  Tests for GridLayout — the React renderer for a Grid<T> binary tree.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import { Direction, Grid, type IGridView } from '@universe-editor/platform'
import { GridLayout } from '../GridLayout.js'

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

describe('GridLayout — sash drag updates grid proportionally', () => {
  it('proportional resize: dragging sash 50px right on a 1000px container grows left panel', () => {
    const { a, b } = makeGrid()
    const grid = new Grid(a)
    grid.addView(b, 100, a, Direction.Right)
    const initialSizeA = grid.getLeafSize(a)
    const initialSizeB = grid.getLeafSize(b)

    const { container } = render(
      <GridLayout grid={grid} viewFactory={(v) => <span data-view={v.viewId} />} />,
    )

    // Mock the branch container's offsetWidth so proportional delta is meaningful.
    const branchDiv = container.querySelector<HTMLElement>('.grid-branch')!
    Object.defineProperty(branchDiv, 'offsetWidth', { value: 1000, configurable: true })

    const sash = container.querySelector('[role="separator"]')!
    fireEvent.mouseDown(sash, { clientX: 500 })
    fireEvent.mouseMove(window, { clientX: 550 })
    fireEvent.mouseUp(window)

    // After dragging right by 50px on a 1000px container with total flex = initialSizeA + initialSizeB,
    // the left panel should have grown and the right panel shrunk.
    expect(grid.getLeafSize(a)).toBeGreaterThan(initialSizeA)
    expect(grid.getLeafSize(b)).toBeLessThan(initialSizeB)
  })

  it('grid fires onDidChange after sash drag', () => {
    const { a, b } = makeGrid()
    const grid = new Grid(a)
    grid.addView(b, 100, a, Direction.Right)

    const { container } = render(
      <GridLayout grid={grid} viewFactory={(v) => <span data-view={v.viewId} />} />,
    )

    const branchDiv2 = container.querySelector<HTMLElement>('.grid-branch')!
    Object.defineProperty(branchDiv2, 'offsetWidth', { value: 800, configurable: true })

    const spy = vi.fn()
    grid.onDidChange(spy)

    const sash = container.querySelector('[role="separator"]')!
    fireEvent.mouseDown(sash, { clientX: 400 })
    fireEvent.mouseMove(window, { clientX: 460 })
    fireEvent.mouseUp(window)

    expect(spy).toHaveBeenCalled()
  })
})
