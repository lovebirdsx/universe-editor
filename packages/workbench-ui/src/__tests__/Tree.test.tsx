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

import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { Tree } from '../tree/Tree.js'
import { TreeModel } from '../tree/TreeModel.js'
import type { ITreeDataSource } from '../tree/ITreeDataSource.js'

interface Node {
  id: string
}

function makeModel(): TreeModel<Node> {
  const roots: Node[] = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  const dataSource: ITreeDataSource<Node> = {
    getId: (n) => n.id,
    hasChildren: () => false,
    getChildren: () => [],
    getRoots: () => roots,
  }
  return new TreeModel<Node>({ dataSource })
}

describe('Tree — click does not scroll the container', () => {
  it('focuses the container with preventScroll on mousedown', () => {
    const model = makeModel()
    render(
      <Tree<Node>
        model={model}
        renderRow={(ctx) => <div data-row-key={ctx.node.id}>{ctx.node.id}</div>}
      />,
    )

    const container = screen.getByRole('tree')
    const focusSpy = vi.spyOn(container, 'focus')

    fireEvent.mouseDown(container)

    expect(focusSpy).toHaveBeenCalledTimes(1)
    expect(focusSpy).toHaveBeenCalledWith({ preventScroll: true })

    model.dispose()
  })
})
