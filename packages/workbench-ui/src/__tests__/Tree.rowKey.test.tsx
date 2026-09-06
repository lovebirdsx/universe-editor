/*---------------------------------------------------------------------------------------------
 *  Regression: `Tree` owns the React key for every row.
 *
 *  `VirtualList`'s default (non-measuring) branch returns `renderItem`'s result
 *  verbatim, so whatever it returns *is* an array element and needs a key. Nine of
 *  the ten tree views happened to set one on their row root; `RemoteTargetsView`
 *  did not, and produced "Each child in a list should have a unique key prop.
 *  Check the render method of `ForwardRef(VirtualListInner)`" at runtime plus
 *  positional reconciliation. `Tree` holds the only correct identity (`node.id`),
 *  so it keys the rows itself and no consumer can omit it again.
 *
 *  Deliberately a separate file: React dedupes this warning per owner component
 *  per module registry, so an earlier test rendering an unkeyed tree would consume
 *  the warning and leave this one passing for the wrong reason.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
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

let errors: string[]

beforeEach(() => {
  errors = []
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map((a) => String(a)).join(' '))
  })
})

afterEach(() => {
  vi.restoreAllMocks()
  cleanup()
})

describe('Tree — row keys', () => {
  it('keys rows itself, so a consumer that omits the key gets no warning', () => {
    const model = makeModel()
    // Row root carries no `key` — exactly what RemoteRow does.
    render(
      <Tree<Node>
        model={model}
        renderRow={(ctx) => <div data-row-key={ctx.node.id}>{ctx.node.id}</div>}
      />,
    )

    expect(screen.getAllByRole('tree')).toHaveLength(1)
    expect(errors.filter((e) => e.includes('unique "key" prop'))).toEqual([])

    model.dispose()
  })
})
