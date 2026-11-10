/*---------------------------------------------------------------------------------------------
 *  Regression: clicking inside a Tree must not scroll the surrounding container.
 *
 *  The Tree container is focusable (role="tree", tabIndex=0) and focuses itself on
 *  mousedown so keyboard navigation works after a click. If that focus() omits
 *  { preventScroll: true }, the browser scrolls the (often long) tree's top edge
 *  back into view — in the SCM view this yanked STAGED CHANGES to the top and moved
 *  the just-clicked inline button out from under the cursor, so the mouseup landed
 *  elsewhere and the first click (e.g. "Unstage All Changes") did nothing.
 *
 *  happy-dom has no layout engine, so the scroll itself can't be replayed; this test
 *  locks the fix at its source: mousedown must call focus({ preventScroll: true }).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Tree } from '../tree/Tree.js'
import { TreeModel } from '../tree/TreeModel.js'
import { seedTreeFocusCursor } from '../tree/focusSeed.js'
import type { ITreeDataSource } from '../tree/ITreeDataSource.js'

interface Node {
  id: string
}

function makeModel(count = 3): TreeModel<Node> {
  const roots: Node[] = Array.from({ length: count }, (_, i) => ({ id: `n${i}` }))
  const dataSource: ITreeDataSource<Node> = {
    getId: (n) => n.id,
    hasChildren: () => false,
    getChildren: () => [],
    getRoots: () => roots,
  }
  return new TreeModel<Node>({ dataSource })
}

function renderRow(ctx: { node: { id: string } }) {
  return <div data-row-key={ctx.node.id}>{ctx.node.id}</div>
}

afterEach(cleanup)

describe('Tree — click does not scroll the container', () => {
  it('focuses the container with preventScroll on mousedown', () => {
    const model = makeModel()
    render(<Tree<Node> model={model} renderRow={renderRow} />)

    const container = screen.getByRole('tree')
    const focusSpy = vi.spyOn(container, 'focus')

    fireEvent.mouseDown(container)

    expect(focusSpy).toHaveBeenCalledTimes(1)
    expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true })

    model.dispose()
  })
})

describe('Tree — focus source', () => {
  it('reports mousedown focus as pointer and programmatic focus as keyboard', () => {
    const model = makeModel()
    const onFocus = vi.fn()
    render(<Tree<Node> model={model} onFocus={onFocus} renderRow={renderRow} />)

    const container = screen.getByRole('tree')
    fireEvent.mouseDown(container)
    expect(onFocus).toHaveBeenCalledWith('pointer')

    act(() => container.blur())
    act(() => container.focus())
    expect(onFocus).toHaveBeenLastCalledWith('keyboard')

    model.dispose()
  })

  it('pointer focus seeds the cursor without scrolling; keyboard focus reveals it', () => {
    const model = makeModel(40)
    render(
      <Tree<Node>
        model={model}
        onFocus={(source) => seedTreeFocusCursor(model, 'n0', source)}
        renderRow={renderRow}
      />,
    )

    const container = screen.getByRole('tree')
    Object.defineProperty(container, 'clientHeight', { configurable: true, value: 110 })
    container.scrollTop = 440

    fireEvent.mouseDown(screen.getByText('n39'))
    expect(model.focused).toBe('n0')
    expect(container.scrollTop).toBe(440)

    // Re-seed from keyboard focus: clear the cursor first, otherwise
    // setSelection early-returns and never fires the reveal.
    act(() => container.blur())
    act(() => model.setSelection([], null))
    container.scrollTop = 440
    act(() => container.focus())
    expect(model.focused).toBe('n0')
    expect(container.scrollTop).toBe(0)

    model.dispose()
  })
})
