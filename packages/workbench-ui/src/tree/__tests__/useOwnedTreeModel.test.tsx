/*---------------------------------------------------------------------------------------------
 *  useOwnedTreeModel keeps a component-owned TreeModel alive across React
 *  StrictMode's mount→unmount→mount dry run, so the tree keeps reacting to data
 *  and refresh() after mount.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { StrictMode, useRef, useState } from 'react'
import { act, render, screen } from '@testing-library/react'
import { type ITreeDataSource } from '../ITreeDataSource.js'
import { TreeModel } from '../TreeModel.js'
import { Tree } from '../Tree.js'
import { useOwnedTreeModel } from '../useOwnedTreeModel.js'

interface N {
  id: string
}

function Harness() {
  // Mutable snapshot the data source reads from; starts empty (data arrives later).
  const rowsRef = useRef<N[]>([])
  const model = useOwnedTreeModel<N>(() => {
    const dataSource: ITreeDataSource<N> = {
      getId: (n) => n.id,
      hasChildren: () => false,
      getChildren: () => [],
      getRoots: () => rowsRef.current,
    }
    return new TreeModel<N>({ dataSource })
  })

  const [, force] = useState(0)
  return (
    <div>
      <button
        onClick={() => {
          rowsRef.current = [{ id: 'foo' }]
          model.refresh()
          force((v) => v + 1)
        }}
      >
        load
      </button>
      <Tree<N> model={model} renderRow={(ctx) => <div key={ctx.node.id}>{ctx.node.id}</div>} />
    </div>
  )
}

describe('useOwnedTreeModel', () => {
  it('renders rows that arrive after mount under StrictMode', async () => {
    render(
      <StrictMode>
        <Harness />
      </StrictMode>,
    )
    expect(screen.queryByText('foo')).toBeNull()

    await act(async () => {
      screen.getByText('load').click()
    })

    expect(await screen.findByText('foo')).toBeTruthy()
  })
})
