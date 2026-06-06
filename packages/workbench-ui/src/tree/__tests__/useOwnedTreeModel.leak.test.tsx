/*---------------------------------------------------------------------------------------------
 *  Regression: useOwnedTreeModel must dispose every TreeModel it constructs.
 *  React StrictMode double-invokes render, so create() can run more than once;
 *  any instance the hook fails to track is orphaned and never disposed. Assert
 *  cascade disposal directly (not via the leak tracker, since the hook marks the
 *  models as singletons to suppress page-reload false positives).
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it } from 'vitest'
import { StrictMode } from 'react'
import { act, cleanup, render } from '@testing-library/react'
import { type ITreeDataSource } from '../ITreeDataSource.js'
import { TreeModel } from '../TreeModel.js'
import { Tree } from '../Tree.js'
import { useOwnedTreeModel } from '../useOwnedTreeModel.js'

interface N {
  id: string
}

describe('useOwnedTreeModel disposal', () => {
  afterEach(() => {
    cleanup()
  })

  it('disposes every TreeModel it creates under StrictMode (no orphan)', async () => {
    const created: TreeModel<N>[] = []

    function Harness() {
      const model = useOwnedTreeModel<N>(() => {
        const dataSource: ITreeDataSource<N> = {
          getId: (n) => n.id,
          hasChildren: () => false,
          getChildren: () => [],
          getRoots: () => [],
        }
        const m = new TreeModel<N>({ dataSource })
        created.push(m)
        return m
      })
      return (
        <Tree<N> model={model} renderRow={(ctx) => <div key={ctx.node.id}>{ctx.node.id}</div>} />
      )
    }

    let unmount!: () => void
    await act(async () => {
      ;({ unmount } = render(
        <StrictMode>
          <Harness />
        </StrictMode>,
      ))
    })

    await act(async () => {
      unmount()
    })

    // Every constructed model — including any extra one StrictMode produced —
    // must be disposed after unmount; a survivor is an orphan leak.
    expect(created.length).toBeGreaterThan(0)
    expect(created.filter((m) => !m.isDisposed)).toHaveLength(0)
  })
})
