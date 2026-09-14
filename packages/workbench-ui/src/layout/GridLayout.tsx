/*---------------------------------------------------------------------------------------------
 *  GridLayout — React renderer for a `Grid<T>` binary tree.
 *
 *  Each branch becomes a flex container in its orientation; each leaf renders
 *  via the supplied `viewFactory`. Sash handles between siblings let the user
 *  resize adjacent leaves.
 *--------------------------------------------------------------------------------------------*/

import { useEffect, useRef, useSyncExternalStore, type ReactNode, type CSSProperties } from 'react'
import {
  Grid,
  GridBranchNode,
  GridLeafNode,
  GridNode,
  IGridView,
  markAsSingleton,
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
      const d = markAsSingleton(grid.onDidChange(() => onChange()))
      return () => d.dispose()
    },
    () => grid.version,
  )
}

// BranchNode is a React component (not a plain function) so it can hold a ref
// to its container div: the root branch reports the pixel size the grid needs
// for every resize (see `Grid.setContainerSize`).
function BranchNode<T extends IGridView>({
  grid,
  branch,
  viewFactory,
}: {
  grid: Grid<T>
  branch: GridBranchNode<T>
  viewFactory: (view: T) => ReactNode
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const isHorizontal = branch.orientation === Orientation.Horizontal
  const isRoot = branch === grid.root
  const flexDir = isHorizontal ? 'row' : 'column'
  const style: CSSProperties = {
    display: 'flex',
    flexDirection: flexDir,
    flex: `${branch.size} 1 0`,
    minWidth: 0,
    minHeight: 0,
    width: '100%',
    height: '100%',
  }

  useEffect(() => {
    if (!isRoot) return
    const el = containerRef.current
    if (!el) return
    const report = () => grid.setContainerSize({ width: el.offsetWidth, height: el.offsetHeight })
    report()
    const observer = new ResizeObserver(report)
    observer.observe(el)
    return () => observer.disconnect()
  }, [grid, isRoot])

  const items: ReactNode[] = []
  branch.children.forEach((child, i) => {
    items.push(renderNode(grid, child, viewFactory))
    if (i < branch.children.length - 1) {
      const left = leftmostLeaf(child)
      items.push(
        <Sash
          key={`sash-${branch.orientation}-${i}-${left?.view.viewId ?? i}`}
          orientation={isHorizontal ? 'vertical' : 'horizontal'}
          onResize={(delta) => grid.resizeSash(branch, i, delta)}
        />,
      )
    }
  })

  return (
    <div ref={containerRef} className="grid-branch" style={style}>
      {items}
    </div>
  )
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

  return (
    <BranchNode
      key={`branch-${leftmostLeaf(node)?.view.viewId ?? node.orientation}`}
      grid={grid}
      branch={node}
      viewFactory={viewFactory}
    />
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
  return <BranchNode grid={grid} branch={grid.root} viewFactory={viewFactory} />
}
