/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  GridLayout — React renderer for a `Grid<T>` binary tree.
 *
 *  Each branch becomes a flex container in its orientation; each leaf renders
 *  via the supplied `viewFactory`. Sash handles between siblings let the user
 *  resize adjacent leaves.
 *--------------------------------------------------------------------------------------------*/

import { useSyncExternalStore, type ReactNode, type CSSProperties } from 'react'
import {
  Grid,
  GridBranchNode,
  GridLeafNode,
  GridNode,
  IGridView,
  Orientation,
} from '@universe-editor/platform'
import { Sash } from './Sash.js'

export interface GridLayoutProps<T extends IGridView> {
  grid: Grid<T>
  viewFactory: (view: T) => ReactNode
}

function useGridVersion<T extends IGridView>(grid: Grid<T>): number {
  return useSyncExternalStore(
    (onChange) => {
      const d = grid.onDidChange(() => onChange())
      return () => d.dispose()
    },
    () => grid.getViews().length,
  )
}

function totalSize<T extends IGridView>(children: GridNode<T>[]): number {
  let sum = 0
  for (const c of children) sum += c.size
  return sum
}

function renderNode<T extends IGridView>(
  grid: Grid<T>,
  node: GridNode<T>,
  viewFactory: (view: T) => ReactNode,
): ReactNode {
  if (node.kind === 'leaf') {
    return (
      <div
        key={`leaf-${node.view.viewId}`}
        className="grid-leaf"
        style={{ flex: `${node.size} 1 0`, minWidth: 0, minHeight: 0, display: 'flex' }}
      >
        {viewFactory(node.view)}
      </div>
    )
  }

  return renderBranch(grid, node, viewFactory)
}

function renderBranch<T extends IGridView>(
  grid: Grid<T>,
  branch: GridBranchNode<T>,
  viewFactory: (view: T) => ReactNode,
): ReactNode {
  const isHorizontal = branch.orientation === Orientation.Horizontal
  const flexDir = isHorizontal ? 'row' : 'column'
  const total = totalSize(branch.children) || 1
  const style: CSSProperties = {
    display: 'flex',
    flexDirection: flexDir,
    flex: `${branch.size} 1 0`,
    minWidth: 0,
    minHeight: 0,
    width: '100%',
    height: '100%',
  }

  const items: ReactNode[] = []
  branch.children.forEach((child, i) => {
    items.push(renderNode(grid, child, viewFactory))
    if (i < branch.children.length - 1) {
      const left = leftmostLeaf(child)
      items.push(
        <Sash
          key={`sash-${branch.orientation}-${i}-${left?.view.viewId ?? i}`}
          orientation={isHorizontal ? 'vertical' : 'horizontal'}
          onResize={(delta) => {
            if (!left) return
            // Convert a pixel delta into a proportional resize. Without explicit
            // sizes, we treat the current size as a unit and add the delta in
            // the same unit space (1 px ≈ 1 unit, which the layout then
            // normalises through flex).
            const dim = isHorizontal
              ? { width: child.size + delta }
              : { height: child.size + delta }
            grid.resizeView(left.view, dim)
            // Suppress unused total warning while keeping calc clarity.
            void total
          }}
        />,
      )
    }
  })

  return (
    <div key={`branch-${branch.orientation}`} className="grid-branch" style={style}>
      {items}
    </div>
  )
}

function leftmostLeaf<T extends IGridView>(node: GridNode<T>): GridLeafNode<T> | undefined {
  if (node.kind === 'leaf') return node
  for (const c of node.children) {
    const r = leftmostLeaf(c)
    if (r) return r
  }
  return undefined
}

export function GridLayout<T extends IGridView>({ grid, viewFactory }: GridLayoutProps<T>) {
  useGridVersion(grid)
  return <>{renderBranch(grid, grid.root, viewFactory)}</>
}
