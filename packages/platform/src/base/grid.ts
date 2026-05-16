/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SerializableGrid — a binary tree of split nodes for arbitrary nested layouts.
 *
 *  Adapted from VSCode's `vs/base/browser/ui/grid/grid.ts` with the following
 *  simplifications:
 *    - No `maximize` / `minimize` (the APIs are intentionally absent).
 *    - No multi-sash drag.
 *    - Min/max sizes from `IGridView` are recorded but only enforced at resize.
 *    - Leaves do not own a DOM element; the React layer is responsible for
 *      rendering each `IGridView` into a positioned box according to the tree
 *      structure that this module describes.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from './event.js'

export const enum Orientation {
  Horizontal = 0,
  Vertical = 1,
}

export const enum Direction {
  Up = 0,
  Down = 1,
  Left = 2,
  Right = 3,
}

export interface IGridView {
  readonly viewId: string
  readonly minimumWidth: number
  readonly maximumWidth: number
  readonly minimumHeight: number
  readonly maximumHeight: number
}

export interface ISerializedGridNode<T> {
  type: 'branch' | 'leaf'
  size: number
  /** Only set on branch nodes. */
  orientation?: Orientation
  children?: ISerializedGridNode<T>[]
  data?: T
}

export interface ISerializedGrid<T> {
  root: ISerializedGridNode<T>
  orientation: Orientation
  width: number
  height: number
}

// Internal node types ---------------------------------------------------------

export type GridNode<T extends IGridView> = GridBranchNode<T> | GridLeafNode<T>

export class GridLeafNode<T extends IGridView> {
  readonly kind = 'leaf' as const
  size: number
  parent: GridBranchNode<T> | undefined = undefined
  constructor(
    readonly view: T,
    size: number,
  ) {
    this.size = size
  }
}

export class GridBranchNode<T extends IGridView> {
  readonly kind = 'branch' as const
  size: number
  parent: GridBranchNode<T> | undefined = undefined
  readonly orientation: Orientation
  readonly children: GridNode<T>[] = []
  constructor(orientation: Orientation, size: number) {
    this.orientation = orientation
    this.size = size
  }
}

// Helpers ---------------------------------------------------------------------

function orientationForDirection(direction: Direction): Orientation {
  return direction === Direction.Left || direction === Direction.Right
    ? Orientation.Horizontal
    : Orientation.Vertical
}

function insertBefore(direction: Direction): boolean {
  return direction === Direction.Up || direction === Direction.Left
}

// Public Grid -----------------------------------------------------------------

export class Grid<T extends IGridView> {
  private _root: GridBranchNode<T>
  private readonly _leaves = new Map<string, GridLeafNode<T>>()

  private readonly _onDidChange = new Emitter<void>()
  readonly onDidChange: Event<void> = this._onDidChange.event

  constructor(view: T, orientation: Orientation = Orientation.Horizontal) {
    this._root = new GridBranchNode<T>(orientation, 1)
    const leaf = new GridLeafNode<T>(view, 1)
    leaf.parent = this._root
    this._root.children.push(leaf)
    this._leaves.set(view.viewId, leaf)
  }

  get orientation(): Orientation {
    return this._root.orientation
  }

  getViews(): readonly T[] {
    const result: T[] = []
    this._collectViews(this._root, result)
    return result
  }

  private _collectViews(node: GridNode<T>, out: T[]): void {
    if (node.kind === 'leaf') {
      out.push(node.view)
      return
    }
    for (const c of node.children) this._collectViews(c, out)
  }

  addView(newView: T, size: number, location: T, direction: Direction): void {
    if (this._leaves.has(newView.viewId)) {
      throw new Error(`Grid: view "${newView.viewId}" already added`)
    }
    const target = this._leaves.get(location.viewId)
    if (!target) throw new Error(`Grid: location view "${location.viewId}" not in grid`)

    const desired = orientationForDirection(direction)
    const before = insertBefore(direction)
    const parent = target.parent!

    const newLeaf = new GridLeafNode<T>(newView, size)

    if (parent.orientation === desired) {
      // Append sibling next to target.
      const idx = parent.children.indexOf(target)
      const insertAt = before ? idx : idx + 1
      newLeaf.parent = parent
      parent.children.splice(insertAt, 0, newLeaf)
    } else {
      // Replace the target leaf with a new branch of the desired orientation
      // containing the target and the new leaf.
      const newBranch = new GridBranchNode<T>(desired, target.size)
      newBranch.parent = parent
      target.size = 1
      newLeaf.size = 1
      target.parent = newBranch
      newLeaf.parent = newBranch
      newBranch.children.push(before ? newLeaf : target, before ? target : newLeaf)
      const idx = parent.children.indexOf(target)
      parent.children.splice(idx, 1, newBranch)
    }

    this._leaves.set(newView.viewId, newLeaf)
    this._onDidChange.fire()
  }

  removeView(view: T): T | undefined {
    const leaf = this._leaves.get(view.viewId)
    if (!leaf) return undefined
    this._leaves.delete(view.viewId)

    const parent = leaf.parent!
    const idx = parent.children.indexOf(leaf)
    parent.children.splice(idx, 1)
    leaf.parent = undefined

    // Collapse branch with a single remaining child into that child (except root).
    this._maybeCollapse(parent)

    this._onDidChange.fire()
    return view
  }

  private _maybeCollapse(branch: GridBranchNode<T>): void {
    if (branch === this._root) {
      // Root must remain a branch; if root has a single sub-branch child we
      // hoist its children up so the tree does not grow needless wrappers.
      if (branch.children.length === 1 && branch.children[0]!.kind === 'branch') {
        const only = branch.children[0] as GridBranchNode<T>
        // Replace root with `only`'s contents but preserve root reference.
        this._root = new GridBranchNode<T>(only.orientation, 1)
        for (const child of only.children) {
          child.parent = this._root
          this._root.children.push(child)
        }
      }
      return
    }
    if (branch.children.length === 1) {
      const only = branch.children[0]!
      const grand = branch.parent!
      const idx = grand.children.indexOf(branch)
      only.parent = grand
      only.size = branch.size
      grand.children.splice(idx, 1, only)
      this._maybeCollapse(grand)
    } else if (branch.children.length === 0) {
      // Empty branch — remove from grandparent.
      const grand = branch.parent
      if (grand) {
        const idx = grand.children.indexOf(branch)
        grand.children.splice(idx, 1)
        this._maybeCollapse(grand)
      }
    }
  }

  moveView(view: T, location: T, direction: Direction): void {
    if (view.viewId === location.viewId) return
    const leaf = this._leaves.get(view.viewId)
    if (!leaf) throw new Error(`Grid: view "${view.viewId}" not in grid`)
    const size = leaf.size
    this.removeView(view)
    this.addView(view, size, location, direction)
  }

  swapViews(a: T, b: T): void {
    const la = this._leaves.get(a.viewId)
    const lb = this._leaves.get(b.viewId)
    if (!la || !lb) throw new Error('Grid: cannot swap unknown view')
    if (la === lb) return
    const pa = la.parent!
    const pb = lb.parent!
    const ia = pa.children.indexOf(la)
    const ib = pb.children.indexOf(lb)
    pa.children[ia] = lb
    pb.children[ib] = la
    const tmpParent = la.parent
    la.parent = lb.parent
    lb.parent = tmpParent
    const tmpSize = la.size
    la.size = lb.size
    lb.size = tmpSize
    this._onDidChange.fire()
  }

  resizeView(view: T, size: { width?: number; height?: number }): void {
    const leaf = this._leaves.get(view.viewId)
    if (!leaf) return
    const parent = leaf.parent!
    const desired = parent.orientation === Orientation.Horizontal ? size.width : size.height
    if (desired === undefined) return
    const min =
      parent.orientation === Orientation.Horizontal
        ? leaf.view.minimumWidth
        : leaf.view.minimumHeight
    const max =
      parent.orientation === Orientation.Horizontal
        ? leaf.view.maximumWidth
        : leaf.view.maximumHeight
    const clamped = Math.max(min, Math.min(max, desired))
    const delta = clamped - leaf.size
    if (delta === 0) return
    // Distribute the inverse delta to the next sibling (the simplest model).
    const idx = parent.children.indexOf(leaf)
    const sibling = parent.children[idx + 1] ?? parent.children[idx - 1]
    if (!sibling) return
    leaf.size = clamped
    sibling.size = Math.max(1, sibling.size - delta)
    this._onDidChange.fire()
  }

  serialize(toData: (view: T) => unknown): ISerializedGrid<unknown> {
    return {
      root: this._serializeNode(this._root, toData),
      orientation: this._root.orientation,
      width: 0,
      height: 0,
    }
  }

  private _serializeNode(
    node: GridNode<T>,
    toData: (view: T) => unknown,
  ): ISerializedGridNode<unknown> {
    if (node.kind === 'leaf') {
      return { type: 'leaf', size: node.size, data: toData(node.view) }
    }
    return {
      type: 'branch',
      size: node.size,
      orientation: node.orientation,
      children: node.children.map((c) => this._serializeNode(c, toData)),
    }
  }

  static deserialize<T extends IGridView>(
    json: ISerializedGrid<unknown>,
    viewFactory: (data: unknown) => T,
  ): Grid<T> {
    // We need a non-empty grid to construct, so seed it with the first leaf
    // found, then rebuild the tree manually.
    const firstLeaf = findFirstLeaf<T>(json.root)
    if (!firstLeaf) throw new Error('Grid: cannot deserialize empty tree')
    const firstView = viewFactory(firstLeaf.data)
    const grid = new Grid<T>(firstView, json.orientation)
    grid._root = grid._buildBranch(json.root, viewFactory)
    // Re-populate the leaves map.
    grid._leaves.clear()
    grid._registerLeaves(grid._root)
    return grid
  }

  private _buildBranch(
    node: ISerializedGridNode<unknown>,
    viewFactory: (data: unknown) => IGridView,
  ): GridBranchNode<T> {
    if (node.type === 'leaf') {
      // The root is required to be a branch, so wrap a single leaf.
      const wrapper = new GridBranchNode<T>(Orientation.Horizontal, node.size)
      const view = viewFactory(node.data) as T
      const leaf = new GridLeafNode<T>(view, 1)
      leaf.parent = wrapper
      wrapper.children.push(leaf)
      return wrapper
    }
    const branch = new GridBranchNode<T>(node.orientation ?? Orientation.Horizontal, node.size)
    for (const child of node.children ?? []) {
      const built = this._buildChild(child, viewFactory)
      built.parent = branch
      branch.children.push(built)
    }
    return branch
  }

  private _buildChild(
    node: ISerializedGridNode<unknown>,
    viewFactory: (data: unknown) => IGridView,
  ): GridNode<T> {
    if (node.type === 'leaf') {
      const view = viewFactory(node.data) as T
      return new GridLeafNode<T>(view, node.size)
    }
    return this._buildBranch(node, viewFactory)
  }

  private _registerLeaves(node: GridNode<T>): void {
    if (node.kind === 'leaf') {
      this._leaves.set(node.view.viewId, node)
      return
    }
    for (const c of node.children) this._registerLeaves(c)
  }

  // Test / debug introspection ------------------------------------------------

  get root(): GridBranchNode<T> {
    return this._root
  }

  hasView(id: string): boolean {
    return this._leaves.has(id)
  }

  getLeafSize(view: T): number {
    return this._leaves.get(view.viewId)?.size ?? 0
  }
}

function findFirstLeaf<T>(
  node: ISerializedGridNode<unknown>,
): ISerializedGridNode<unknown> | undefined {
  if (node.type === 'leaf') return node
  for (const c of node.children ?? []) {
    const found = findFirstLeaf<T>(c)
    if (found) return found
  }
  return undefined
}
