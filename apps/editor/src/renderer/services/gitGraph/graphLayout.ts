/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Git Graph swim-lane layout — a DOM-free port of vscode-git-graph's web/graph.ts
 *  (Graph/Vertex/Branch + determinePath/getAvailableColour). Given the commit DAG
 *  it assigns each commit a lane (x) and colour, and emits SVG path data for the
 *  branch lines. The renderer turns this into <svg> elements; no part of this file
 *  touches the DOM, so it is unit-testable in isolation.
 *--------------------------------------------------------------------------------------------*/

const NULL_VERTEX_ID = -1

export interface GraphCommitInput {
  readonly hash: string
  readonly parents: readonly string[]
  readonly isStash?: boolean
  /** The synthetic working-tree node: drawn hollow with a dashed link to HEAD. */
  readonly isUncommitted?: boolean
}

export interface GraphGrid {
  /** Horizontal spacing between lanes, px. */
  readonly x: number
  /** Vertical spacing between commits, px (must equal the commit row height). */
  readonly y: number
  readonly offsetX: number
  readonly offsetY: number
}

export type GraphStyle = 'rounded' | 'angular'

/** An inline gap inserted after `afterIndex`, shifting later rows down by `height` px. */
export interface GraphExpand {
  readonly afterIndex: number
  readonly height: number
}

export interface GraphLayoutOptions {
  readonly grid: GraphGrid
  readonly style?: GraphStyle
  /** Mirror git-graph's `onlyFollowFirstParent`. Defaults to false. */
  readonly onlyFollowFirstParent?: boolean
  /** Inline detail expansion: pushes commits below `afterIndex` down by `height`. */
  readonly expand?: GraphExpand
}

/** Placement of a single commit node (index === commit index === row). */
export interface VertexPlacement {
  readonly id: number
  /** Logical lane index. */
  readonly lane: number
  /** Pixel centre. */
  readonly cx: number
  readonly cy: number
  /** Colour index (caller maps to a palette, taking modulo palette length). */
  readonly colour: number
  readonly isCurrent: boolean
  readonly isStash: boolean
  /** The synthetic working-tree node at the top of the graph. */
  readonly isUncommitted: boolean
}

/** A renderable branch-line path. */
export interface GraphPath {
  readonly d: string
  readonly colour: number
  readonly isCommitted: boolean
}

export interface GraphLayout {
  readonly vertices: VertexPlacement[]
  readonly paths: GraphPath[]
  /** SVG content width, px. */
  readonly width: number
  /** SVG content height, px. */
  readonly height: number
  readonly laneCount: number
}

interface Point {
  readonly x: number
  readonly y: number
}

interface Line {
  readonly p1: Point
  readonly p2: Point
  /** TRUE => locked to p1, FALSE => locked to p2. */
  readonly lockedFirst: boolean
}

interface Pixel {
  x: number
  y: number
}

interface PlacedLine {
  p1: Pixel
  p2: Pixel
  readonly isCommitted: boolean
  readonly lockedFirst: boolean
}

interface UnavailablePoint {
  readonly connectsTo: Vertex | null
  readonly onBranch: Branch
}

class Branch {
  private readonly _colour: number
  private _end = 0
  private readonly _lines: Line[] = []
  private _numUncommitted = 0

  constructor(colour: number) {
    this._colour = colour
  }

  addLine(p1: Point, p2: Point, isCommitted: boolean, lockedFirst: boolean): void {
    this._lines.push({ p1, p2, lockedFirst })
    if (isCommitted) {
      if (p2.x === 0 && p2.y < this._numUncommitted) this._numUncommitted = p2.y
    } else {
      this._numUncommitted++
    }
  }

  get colour(): number {
    return this._colour
  }

  get lines(): readonly Line[] {
    return this._lines
  }

  get numUncommitted(): number {
    return this._numUncommitted
  }

  setEnd(end: number): void {
    this._end = end
  }

  getEnd(): number {
    return this._end
  }
}

class Vertex {
  readonly id: number
  readonly isStash: boolean

  private _x = 0
  private readonly _children: Vertex[] = []
  private readonly _parents: Vertex[] = []
  private _nextParent = 0
  private _onBranch: Branch | null = null
  private _isCommitted = true
  private _isCurrent = false
  private _nextX = 0
  private readonly _connections: UnavailablePoint[] = []

  constructor(id: number, isStash: boolean) {
    this.id = id
    this.isStash = isStash
  }

  addChild(vertex: Vertex): void {
    this._children.push(vertex)
  }

  getChildren(): readonly Vertex[] {
    return this._children
  }

  addParent(vertex: Vertex): void {
    this._parents.push(vertex)
  }

  hasParents(): boolean {
    return this._parents.length > 0
  }

  getNextParent(): Vertex | null {
    return this._parents[this._nextParent] ?? null
  }

  registerParentProcessed(): void {
    this._nextParent++
  }

  isMerge(): boolean {
    return this._parents.length > 1
  }

  addToBranch(branch: Branch, x: number): void {
    if (this._onBranch === null) {
      this._onBranch = branch
      this._x = x
    }
  }

  isNotOnBranch(): boolean {
    return this._onBranch === null
  }

  getBranch(): Branch | null {
    return this._onBranch
  }

  getPoint(): Point {
    return { x: this._x, y: this.id }
  }

  getNextPoint(): Point {
    return { x: this._nextX, y: this.id }
  }

  getPointConnectingTo(vertex: Vertex | null, onBranch: Branch): Point | null {
    for (let i = 0; i < this._connections.length; i++) {
      const conn = this._connections[i]
      if (conn && conn.connectsTo === vertex && conn.onBranch === onBranch) {
        return { x: i, y: this.id }
      }
    }
    return null
  }

  registerUnavailablePoint(x: number, connectsToVertex: Vertex | null, onBranch: Branch): void {
    if (x === this._nextX) {
      this._nextX = x + 1
      this._connections[x] = { connectsTo: connectsToVertex, onBranch }
    }
  }

  getColour(): number {
    return this._onBranch !== null ? this._onBranch.colour : 0
  }

  getIsCommitted(): boolean {
    return this._isCommitted
  }

  setNotCommitted(): void {
    this._isCommitted = false
  }

  setCurrent(): void {
    this._isCurrent = true
  }

  get isCurrent(): boolean {
    return this._isCurrent
  }
}

class Graph {
  private readonly _vertices: Vertex[] = []
  private readonly _branches: Branch[] = []
  private readonly _availableColours: number[] = []
  private readonly _onlyFollowFirstParent: boolean

  constructor(
    commits: readonly GraphCommitInput[],
    commitHead: string | null,
    onlyFollowFirstParent: boolean,
  ) {
    this._onlyFollowFirstParent = onlyFollowFirstParent
    if (commits.length === 0) return

    const commitLookup: Record<string, number> = {}
    for (let i = 0; i < commits.length; i++) {
      commitLookup[commits[i]!.hash] = i
    }

    const nullVertex = new Vertex(NULL_VERTEX_ID, false)
    for (let i = 0; i < commits.length; i++) {
      this._vertices.push(new Vertex(i, commits[i]!.isStash === true))
    }
    for (let i = 0; i < commits.length; i++) {
      if (commits[i]!.isUncommitted === true) this._vertices[i]!.setNotCommitted()
    }
    for (let i = 0; i < commits.length; i++) {
      const parents = commits[i]!.parents
      for (let j = 0; j < parents.length; j++) {
        const parentIdx = commitLookup[parents[j]!]
        if (typeof parentIdx === 'number') {
          this._vertices[i]!.addParent(this._vertices[parentIdx]!)
          this._vertices[parentIdx]!.addChild(this._vertices[i]!)
        } else if (!this._onlyFollowFirstParent || j === 0) {
          this._vertices[i]!.addParent(nullVertex)
        }
      }
    }

    if (commitHead !== null && typeof commitLookup[commitHead] === 'number') {
      this._vertices[commitLookup[commitHead]!]!.setCurrent()
    }

    let i = 0
    while (i < this._vertices.length) {
      const v = this._vertices[i]!
      if (v.getNextParent() !== null || v.isNotOnBranch()) {
        this._determinePath(i)
      } else {
        i++
      }
    }
  }

  private _determinePath(startAt: number): void {
    let i = startAt
    let vertex = this._vertices[i]!
    let parentVertex = vertex.getNextParent()
    let lastPoint = vertex.isNotOnBranch() ? vertex.getNextPoint() : vertex.getPoint()
    let curVertex: Vertex
    let curPoint: Point

    if (
      parentVertex !== null &&
      parentVertex.id !== NULL_VERTEX_ID &&
      vertex.isMerge() &&
      !vertex.isNotOnBranch() &&
      !parentVertex.isNotOnBranch()
    ) {
      // Merge between two vertices already on branches.
      let foundPointToParent = false
      const parentBranch = parentVertex.getBranch()!
      for (i = startAt + 1; i < this._vertices.length; i++) {
        curVertex = this._vertices[i]!
        const connecting = curVertex.getPointConnectingTo(parentVertex, parentBranch)
        if (connecting !== null) {
          curPoint = connecting
          foundPointToParent = true
        } else {
          curPoint = curVertex.getNextPoint()
        }
        parentBranch.addLine(
          lastPoint,
          curPoint,
          vertex.getIsCommitted(),
          !foundPointToParent && curVertex !== parentVertex ? lastPoint.x < curPoint.x : true,
        )
        curVertex.registerUnavailablePoint(curPoint.x, parentVertex, parentBranch)
        lastPoint = curPoint

        if (foundPointToParent) {
          vertex.registerParentProcessed()
          break
        }
      }
    } else {
      // Normal branch.
      const branch = new Branch(this._getAvailableColour(startAt))
      vertex.addToBranch(branch, lastPoint.x)
      vertex.registerUnavailablePoint(lastPoint.x, vertex, branch)
      for (i = startAt + 1; i < this._vertices.length; i++) {
        curVertex = this._vertices[i]!
        curPoint =
          parentVertex === curVertex && !parentVertex.isNotOnBranch()
            ? curVertex.getPoint()
            : curVertex.getNextPoint()
        branch.addLine(lastPoint, curPoint, vertex.getIsCommitted(), lastPoint.x < curPoint.x)
        curVertex.registerUnavailablePoint(curPoint.x, parentVertex, branch)
        lastPoint = curPoint

        if (parentVertex === curVertex) {
          vertex.registerParentProcessed()
          const parentVertexOnBranch = !parentVertex.isNotOnBranch()
          parentVertex.addToBranch(branch, curPoint.x)
          vertex = parentVertex
          parentVertex = vertex.getNextParent()
          if (parentVertex === null || parentVertexOnBranch) break
        }
      }
      if (
        i === this._vertices.length &&
        parentVertex !== null &&
        parentVertex.id === NULL_VERTEX_ID
      ) {
        vertex.registerParentProcessed()
      }
      branch.setEnd(i)
      this._branches.push(branch)
      this._availableColours[branch.colour] = i
    }
  }

  private _getAvailableColour(startAt: number): number {
    for (let i = 0; i < this._availableColours.length; i++) {
      if (startAt > this._availableColours[i]!) {
        return i
      }
    }
    this._availableColours.push(0)
    return this._availableColours.length - 1
  }

  toLayout(grid: GraphGrid, style: GraphStyle, expand?: GraphExpand): GraphLayout {
    const gap = expand && expand.height > 0 ? expand : null
    const yOf = (logicalY: number): number =>
      logicalY * grid.y + grid.offsetY + (gap && logicalY > gap.afterIndex ? gap.height : 0)

    const vertices: VertexPlacement[] = this._vertices.map((v) => {
      const point = v.getPoint()
      return {
        id: v.id,
        lane: point.x,
        cx: point.x * grid.x + grid.offsetX,
        cy: yOf(v.id),
        colour: v.getColour(),
        isCurrent: v.isCurrent,
        isStash: v.isStash,
        isUncommitted: !v.getIsCommitted(),
      }
    })

    const paths: GraphPath[] = []
    for (const branch of this._branches) {
      paths.push(...branchToPaths(branch, grid, style, yOf))
    }

    let maxNextX = 0
    for (const v of this._vertices) {
      const nx = v.getNextPoint().x
      if (nx > maxNextX) maxNextX = nx
    }
    const laneCount = maxNextX
    const width = 2 * grid.offsetX + Math.max(0, laneCount - 1) * grid.x
    const base =
      this._vertices.length > 0 ? this._vertices.length * grid.y + grid.offsetY - grid.y / 2 : 0
    const height = base + (gap ? gap.height : 0)

    return { vertices, paths, width, height, laneCount }
  }
}

/** Port of Branch.draw — converts logical lines into renderable SVG paths. */
function branchToPaths(
  branch: Branch,
  grid: GraphGrid,
  style: GraphStyle,
  yOf: (logicalY: number) => number,
): GraphPath[] {
  const d = grid.y * (style === 'angular' ? 0.38 : 0.8)
  const placed: PlacedLine[] = branch.lines.map((line, i) => ({
    p1: { x: line.p1.x * grid.x + grid.offsetX, y: yOf(line.p1.y) },
    p2: { x: line.p2.x * grid.x + grid.offsetX, y: yOf(line.p2.y) },
    isCommitted: i >= branch.numUncommitted,
    lockedFirst: line.lockedFirst,
  }))

  // Collapse consecutive vertical segments sharing an endpoint.
  let i = 0
  while (i < placed.length - 1) {
    const line = placed[i]!
    const next = placed[i + 1]!
    if (
      line.p1.x === line.p2.x &&
      line.p2.x === next.p1.x &&
      next.p1.x === next.p2.x &&
      line.p2.y === next.p1.y &&
      line.isCommitted === next.isCommitted
    ) {
      line.p2.y = next.p2.y
      placed.splice(i + 1, 1)
    } else {
      i++
    }
  }

  const paths: GraphPath[] = []
  let curPath = ''
  for (i = 0; i < placed.length; i++) {
    const line = placed[i]!
    const prev = i > 0 ? placed[i - 1]! : null
    const x1 = line.p1.x
    const y1 = line.p1.y
    const x2 = line.p2.x
    const y2 = line.p2.y

    if (curPath !== '' && prev && line.isCommitted !== prev.isCommitted) {
      paths.push({ d: curPath, colour: branch.colour, isCommitted: prev.isCommitted })
      curPath = ''
    }

    if (curPath === '' || (prev && (x1 !== prev.p2.x || y1 !== prev.p2.y))) {
      curPath += 'M' + x1.toFixed(0) + ',' + y1.toFixed(1)
    }

    if (x1 === x2) {
      curPath += 'L' + x2.toFixed(0) + ',' + y2.toFixed(1)
    } else if (style === 'angular') {
      curPath +=
        'L' +
        (line.lockedFirst
          ? x2.toFixed(0) + ',' + (y2 - d).toFixed(1)
          : x1.toFixed(0) + ',' + (y1 + d).toFixed(1)) +
        'L' +
        x2.toFixed(0) +
        ',' +
        y2.toFixed(1)
    } else {
      curPath +=
        'C' +
        x1.toFixed(0) +
        ',' +
        (y1 + d).toFixed(1) +
        ' ' +
        x2.toFixed(0) +
        ',' +
        (y2 - d).toFixed(1) +
        ' ' +
        x2.toFixed(0) +
        ',' +
        y2.toFixed(1)
    }
  }
  if (curPath !== '') {
    paths.push({
      d: curPath,
      colour: branch.colour,
      isCommitted: placed[placed.length - 1]!.isCommitted,
    })
  }
  return paths
}

/**
 * Compute the swim-lane layout for a list of commits ordered newest-first.
 * `headHash` marks the current commit (drawn as a hollow node).
 */
export function computeGraphLayout(
  commits: readonly GraphCommitInput[],
  headHash: string | null,
  options: GraphLayoutOptions,
): GraphLayout {
  const graph = new Graph(commits, headHash, options.onlyFollowFirstParent === true)
  return graph.toLayout(options.grid, options.style ?? 'rounded', options.expand)
}
