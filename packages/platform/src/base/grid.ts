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

export type GridAxis = 'width' | 'height'

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

function axisOrientation(axis: GridAxis): Orientation {
  return axis === 'width' ? Orientation.Horizontal : Orientation.Vertical
}

function totalSize<T extends IGridView>(nodes: readonly GridNode<T>[]): number {
  let sum = 0
  for (const node of nodes) sum += node.size
  return sum
}

function sanitizeExtent(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0
}

function insertBefore(direction: Direction): boolean {
  return direction === Direction.Up || direction === Direction.Left
}

// Public Grid -----------------------------------------------------------------

export class Grid<T extends IGridView> {
  private _root: GridBranchNode<T>
  private readonly _leaves = new Map<string, GridLeafNode<T>>()
  private _version = 0
  private _containerSize: { width: number; height: number } | undefined

  private readonly _onDidChange = new Emitter<void>()
  readonly onDidChange: Event<void> = this._onDidChange.event

  /** Monotonically increasing counter; changes on every structural or size update. */
  get version(): number {
    return this._version
  }

  private _notifyChange(): void {
    this._version++
    this._onDidChange.fire()
  }

  constructor(view: T, orientation: Orientation = Orientation.Horizontal) {
    this._root = new GridBranchNode<T>(orientation, 1)
    // Node sizes are unit-less flex weights: only their ratios matter for
    // rendering. Pixels enter the picture exclusively through the container
    // size reported by the renderer (see `setContainerSize`).
    const leaf = new GridLeafNode<T>(view, 500)
    leaf.parent = this._root
    this._root.children.push(leaf)
    this._leaves.set(view.viewId, leaf)
  }

  get orientation(): Orientation {
    return this._root.orientation
  }

  /**
   * Report the pixel size of the container this grid is rendered into. Every
   * pixel↔flex conversion and every `IGridView` min/max constraint depends on
   * it; before the first measurement a resize cannot move anything.
   *
   * Deliberately does NOT fire `onDidChange`: a container resize leaves the
   * flex ratios untouched, and notifying would re-render every editor group
   * (Monaco included) on each window resize.
   */
  setContainerSize(size: { width: number; height: number }): void {
    this._containerSize = {
      width: sanitizeExtent(size.width),
      height: sanitizeExtent(size.height),
    }
  }

  getContainerSize(): { width: number; height: number } | undefined {
    return this._containerSize ? { ...this._containerSize } : undefined
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
      // Append sibling next to target; give the new leaf the same flex size
      // as the target so both panels share the space equally.
      const idx = parent.children.indexOf(target)
      const insertAt = before ? idx : idx + 1
      newLeaf.size = target.size
      newLeaf.parent = parent
      parent.children.splice(insertAt, 0, newLeaf)
    } else {
      // Replace the target leaf with a new branch of the desired orientation
      // containing the target and the new leaf.  Both children start with the
      // same size so they split the available space equally.
      const newBranch = new GridBranchNode<T>(desired, target.size)
      newBranch.parent = parent
      newLeaf.size = target.size
      target.parent = newBranch
      newLeaf.parent = newBranch
      newBranch.children.push(before ? newLeaf : target, before ? target : newLeaf)
      const idx = parent.children.indexOf(target)
      parent.children.splice(idx, 1, newBranch)
    }

    this._leaves.set(newView.viewId, newLeaf)
    this._notifyChange()
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

    this._notifyChange()
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
    this._notifyChange()
  }

  /**
   * Resize `view` by `deltaPx` along `axis` (positive = larger), trading the
   * space with its nearest sibling split. Walks up from the leaf to the closest
   * ancestor split that runs along `axis`, which is what a "grow my column"
   * request means even when the leaf sits inside a perpendicular sub-branch.
   *
   * Returns whether the grid owns a split along that axis. `false` tells the
   * caller to fall back to resizing the workbench chrome; a request that gets
   * clamped still returns `true` (nothing moves) so that reaching a group's
   * minimum never silently switches the shortcut over to the sidebar.
   */
  resizeViewByDelta(view: T, axis: GridAxis, deltaPx: number): boolean {
    const leafNode = this._leaves.get(view.viewId)
    if (!leafNode) return false
    const wanted = axisOrientation(axis)

    let node: GridNode<T> = leafNode
    for (;;) {
      const parent: GridBranchNode<T> | undefined = node.parent
      if (!parent) return false
      if (parent.orientation === wanted && parent.children.length >= 2) {
        const index = parent.children.indexOf(node)
        if (index === -1) return false
        const siblingIndex = index + 1 < parent.children.length ? index + 1 : index - 1
        if (siblingIndex < 0) return false
        this._applyDelta(parent, index, siblingIndex, deltaPx)
        return true
      }
      // A single-child branch (the wrapper `deserialize` builds for a lone
      // root leaf) owns no split — keep walking up instead of giving up.
      if (parent === this._root) return false
      node = parent
    }
  }

  /**
   * Resize the split between `branch.children[index]` and
   * `branch.children[index + 1]` by `deltaPx` (positive = first child larger).
   *
   * The sash names its own split explicitly. Resolving it through a leaf
   * (`leftmostLeaf` + walk up) picks the innermost matching branch instead,
   * which is the wrong one for nested layouts such as
   * `Root(H)[V(H(A,B), C), D]`, where the V|D sash would move the A|B split.
   */
  resizeSash(branch: GridBranchNode<T>, index: number, deltaPx: number): void {
    if (index < 0 || index + 1 >= branch.children.length) return
    if (!this._isAttached(branch)) return
    this._applyDelta(branch, index, index + 1, deltaPx)
  }

  /** Pixel box of `view` derived from the flex ratios; `undefined` before the first measurement. */
  getViewSize(view: T): { width: number; height: number } | undefined {
    const leafNode = this._leaves.get(view.viewId)
    if (!leafNode || !this._containerSize) return undefined
    return {
      width: this._extentAlongAxis(leafNode, Orientation.Horizontal),
      height: this._extentAlongAxis(leafNode, Orientation.Vertical),
    }
  }

  /**
   * Grow/shrink `parent.children[index]` by `deltaPx` (positive = larger) and
   * hand the opposite amount to `parent.children[siblingIndex]`. The only place
   * that writes sibling sizes around a split.
   *
   * Computed in pixels: `IGridView`'s min/max constraints and every caller's
   * step are pixels while node sizes are flex weights, so the conversion lives
   * here and nowhere else. The flex pair sum is preserved exactly, so repeated
   * resizes cannot drift.
   */
  private _applyDelta(
    parent: GridBranchNode<T>,
    index: number,
    siblingIndex: number,
    deltaPx: number,
  ): void {
    const node = parent.children[index]
    const sibling = parent.children[siblingIndex]
    if (!node || !sibling || node === sibling) return

    const axis = parent.orientation
    const extent = this._extentAlongAxis(parent, axis)
    const total = totalSize(parent.children)
    // The flex pair sum is what keeps the split's share of the parent intact
    // (see below), so a degenerate pair cannot be resized at all.
    const pairSum = node.size + sibling.size
    if (!(extent > 0) || total <= 0 || pairSum <= 0) return

    const pxPerFlex = extent / total
    const nodePx = node.size * pxPerFlex
    const siblingPx = sibling.size * pxPerFlex
    const nodeMax = this._axisMax(node, axis)
    const siblingMax = this._axisMax(sibling, axis)

    // Feasible window for the delta = what `node` may become ∩ what `sibling`
    // can give up or absorb.
    let lo = Math.max(this._axisMin(node, axis) - nodePx, siblingPx - siblingMax)
    let hi = Math.min(nodeMax - nodePx, siblingPx - this._axisMin(sibling, axis))
    if (!(hi >= lo)) {
      // A container narrower than the sum of both minimums has already put this
      // split below them, so honouring the minimums would leave an empty window
      // and freeze the divider (a sash that cannot move, a shortcut that claims
      // the axis and then does nothing). Keep the maximums and the floor that
      // leaves both sides non-negative — movement beats a dead separator.
      lo = Math.max(-nodePx, siblingPx - siblingMax)
      hi = Math.min(nodeMax - nodePx, siblingPx)
    }

    const applied = Math.min(hi, Math.max(lo, deltaPx))
    if (!Number.isFinite(applied) || applied === 0) return

    // Keeping the pair's total flex constant is what makes repeated resizes
    // drift-free: the split's share of the parent never changes.
    node.size = (nodePx + applied) / pxPerFlex
    sibling.size = pairSum - node.size
    this._notifyChange()
  }

  /**
   * Pixel length of `node`'s box along `orientation`, obtained by walking down
   * from the root and multiplying the ratios of the branches that run along
   * that axis (a perpendicular branch leaves the length untouched).
   */
  private _extentAlongAxis(node: GridNode<T>, orientation: Orientation): number {
    const container = this._containerSize
    if (!container) return 0

    const path: GridNode<T>[] = []
    for (let n: GridNode<T> | undefined = node; n; n = n.parent) path.push(n)
    path.reverse()

    let extent = orientation === Orientation.Horizontal ? container.width : container.height
    for (let i = 1; i < path.length; i++) {
      const parent = path[i - 1]
      const child = path[i]
      if (!parent || !child || parent.kind !== 'branch') continue
      if (parent.orientation !== orientation) continue
      const total = totalSize(parent.children)
      if (total <= 0) return 0
      extent *= child.size / total
    }
    return extent
  }

  private _axisMin(node: GridNode<T>, orientation: Orientation): number {
    if (node.kind === 'leaf') {
      return orientation === Orientation.Horizontal
        ? node.view.minimumWidth
        : node.view.minimumHeight
    }
    const childMins = node.children.map((child) => this._axisMin(child, orientation))
    if (childMins.length === 0) return 0
    // Splitting along the axis stacks the children's lengths (minimums add up);
    // splitting across the axis leaves each child at full length (largest wins).
    return node.orientation === orientation
      ? childMins.reduce((a, b) => a + b, 0)
      : Math.max(...childMins)
  }

  private _axisMax(node: GridNode<T>, orientation: Orientation): number {
    if (node.kind === 'leaf') {
      return orientation === Orientation.Horizontal
        ? node.view.maximumWidth
        : node.view.maximumHeight
    }
    const childMaxes = node.children.map((child) => this._axisMax(child, orientation))
    if (childMaxes.length === 0) return Number.POSITIVE_INFINITY
    return node.orientation === orientation
      ? childMaxes.reduce((a, b) => a + b, 0)
      : Math.min(...childMaxes)
  }

  /** Guards against a branch captured before `_maybeCollapse` replaced the root. */
  private _isAttached(branch: GridBranchNode<T>): boolean {
    let node: GridNode<T> = branch
    while (node.parent) node = node.parent
    return node === this._root
  }

  serialize(toData: (view: T) => unknown): ISerializedGrid<unknown> {
    return {
      root: this._serializeNode(this._root, toData),
      orientation: this._root.orientation,
      width: 0,
      height: 0,
    }
  }

  /**
   * Replace the current grid tree in-place with the structure described by
   * `serializedRoot`.  `viewFactory` is called once per leaf in pre-order
   * (left-to-right depth-first) traversal — the same order that
   * `collectLeavesInOrder` in `editorGroupsPersistence` produces.
   *
   * This is the correct way to restore a persisted layout: the full tree
   * topology is reconstructed at once, so branch orientations and nesting
   * depths are preserved exactly.  Sequential `addView` calls cannot express
   * every possible tree (e.g. a branch node that is a sibling of a leaf) and
   * therefore produce incorrect layouts for arrangements with depth > 1.
   *
   * Fires `onDidChange` once after the tree has been replaced.
   */
  rebuildFrom(
    serializedRoot: ISerializedGridNode<unknown>,
    viewFactory: (data: unknown) => T,
  ): void {
    this._leaves.clear()
    this._root = this._buildBranch(serializedRoot, viewFactory as (data: unknown) => IGridView)
    this._registerLeaves(this._root)
    this._notifyChange()
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
