/*---------------------------------------------------------------------------------------------
 *  Tests for SerializableGrid — binary-tree split container.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from 'vitest'
import { Direction, Grid, IGridView, Orientation } from '../../base/grid.js'

class V implements IGridView {
  readonly minimumWidth = 50
  readonly maximumWidth = Number.POSITIVE_INFINITY
  readonly minimumHeight = 50
  readonly maximumHeight = Number.POSITIVE_INFINITY
  constructor(readonly viewId: string) {}
}

describe('Grid — construction', () => {
  it('initial grid contains the seed view', () => {
    const a = new V('a')
    const grid = new Grid(a)
    expect(grid.getViews()).toEqual([a])
    expect(grid.hasView('a')).toBe(true)
  })

  it('default orientation is Horizontal', () => {
    const grid = new Grid(new V('a'))
    expect(grid.orientation).toBe(Orientation.Horizontal)
  })
})

describe('Grid — addView', () => {
  it('split right creates a 2-leaf horizontal arrangement', () => {
    const a = new V('a')
    const b = new V('b')
    const grid = new Grid(a)
    grid.addView(b, 200, a, Direction.Right)
    expect(grid.getViews()).toEqual([a, b])
    expect(grid.root.orientation).toBe(Orientation.Horizontal)
  })

  it('split down on horizontal root wraps target into a vertical branch', () => {
    const a = new V('a')
    const b = new V('b')
    const grid = new Grid(a, Orientation.Horizontal)
    grid.addView(b, 200, a, Direction.Down)
    // Root is horizontal; vertical sub-branch under root contains [a, b].
    expect(grid.root.children.length).toBe(1)
    const sub = grid.root.children[0]
    expect(sub?.kind).toBe('branch')
    if (sub && sub.kind === 'branch') {
      expect(sub.orientation).toBe(Orientation.Vertical)
      expect(sub.children.length).toBe(2)
    }
  })

  it('split left inserts the new view before the target', () => {
    const a = new V('a')
    const b = new V('b')
    const grid = new Grid(a)
    grid.addView(b, 100, a, Direction.Left)
    expect(grid.getViews()).toEqual([b, a])
  })

  it('nested splits: right then down forms depth-2 tree', () => {
    const a = new V('a')
    const b = new V('b')
    const c = new V('c')
    const grid = new Grid(a)
    grid.addView(b, 100, a, Direction.Right)
    grid.addView(c, 100, b, Direction.Down)
    expect(grid.getViews()).toEqual([a, b, c])
  })

  it('throws when adding a duplicate view id', () => {
    const a = new V('a')
    const grid = new Grid(a)
    expect(() => grid.addView(new V('a'), 100, a, Direction.Right)).toThrow()
  })

  it('throws when location is not in the grid', () => {
    const grid = new Grid(new V('a'))
    expect(() => grid.addView(new V('b'), 100, new V('ghost'), Direction.Right)).toThrow()
  })

  it('fires onDidChange on addView', () => {
    const a = new V('a')
    const grid = new Grid(a)
    const spy = vi.fn()
    grid.onDidChange(spy)
    grid.addView(new V('b'), 100, a, Direction.Right)
    expect(spy).toHaveBeenCalledOnce()
  })

  it('version increments on addView', () => {
    const a = new V('a')
    const grid = new Grid(a)
    const before = grid.version
    grid.addView(new V('b'), 100, a, Direction.Right)
    expect(grid.version).toBe(before + 1)
  })
})

describe('Grid — removeView', () => {
  it('removes a leaf and collapses the parent when only one sibling remains', () => {
    const a = new V('a')
    const b = new V('b')
    const grid = new Grid(a)
    grid.addView(b, 100, a, Direction.Right)
    grid.removeView(b)
    expect(grid.getViews()).toEqual([a])
    expect(grid.hasView('b')).toBe(false)
  })

  it('returns undefined for unknown view', () => {
    const grid = new Grid(new V('a'))
    expect(grid.removeView(new V('ghost'))).toBeUndefined()
  })

  it('collapses nested branches up the tree', () => {
    const a = new V('a')
    const b = new V('b')
    const c = new V('c')
    const grid = new Grid(a)
    grid.addView(b, 100, a, Direction.Right)
    grid.addView(c, 100, b, Direction.Down)
    grid.removeView(c)
    expect(grid.getViews()).toEqual([a, b])
  })

  it('fires onDidChange on removeView', () => {
    const a = new V('a')
    const b = new V('b')
    const grid = new Grid(a)
    grid.addView(b, 100, a, Direction.Right)
    const spy = vi.fn()
    grid.onDidChange(spy)
    grid.removeView(b)
    expect(spy).toHaveBeenCalledOnce()
  })
})

describe('Grid — moveView', () => {
  it('moveView relocates a leaf relative to another view', () => {
    const a = new V('a')
    const b = new V('b')
    const c = new V('c')
    const grid = new Grid(a)
    grid.addView(b, 100, a, Direction.Right)
    grid.addView(c, 100, b, Direction.Right)
    grid.moveView(a, c, Direction.Right)
    const views = grid.getViews()
    expect(views).toContain(a)
    expect(views).toContain(b)
    expect(views).toContain(c)
    expect(views[views.length - 1]).toBe(a)
  })

  it('moveView on the same view is a no-op', () => {
    const a = new V('a')
    const grid = new Grid(a)
    grid.moveView(a, a, Direction.Right)
    expect(grid.getViews()).toEqual([a])
  })
})

describe('Grid — swapViews', () => {
  it('swapViews exchanges leaf positions', () => {
    const a = new V('a')
    const b = new V('b')
    const grid = new Grid(a)
    grid.addView(b, 100, a, Direction.Right)
    grid.swapViews(a, b)
    expect(grid.getViews()).toEqual([b, a])
  })

  it('swapViews fires onDidChange', () => {
    const a = new V('a')
    const b = new V('b')
    const grid = new Grid(a)
    grid.addView(b, 100, a, Direction.Right)
    const spy = vi.fn()
    grid.onDidChange(spy)
    grid.swapViews(a, b)
    expect(spy).toHaveBeenCalledOnce()
  })
})

describe('Grid — addView equal split', () => {
  it('sibling split ignores the passed size and matches the target size instead', () => {
    const a = new V('a')
    const b = new V('b')
    const grid = new Grid(a)
    const targetSize = grid.getLeafSize(a)
    grid.addView(b, 9999, a, Direction.Right) // large size arg should be ignored
    expect(grid.getLeafSize(b)).toBe(targetSize)
    expect(grid.getLeafSize(a)).toBe(targetSize)
  })

  it('else-branch split gives both children equal size', () => {
    const a = new V('a')
    const b = new V('b')
    const grid = new Grid(a)
    const targetSize = grid.getLeafSize(a)
    grid.addView(b, 9999, a, Direction.Down) // vertical creates a new sub-branch
    // a's size within the new branch should still equal its original size
    expect(grid.getLeafSize(a)).toBe(targetSize)
    // b should match
    expect(grid.getLeafSize(b)).toBe(targetSize)
  })

  it('sequential right splits each produce an equal-sized panel', () => {
    const a = new V('a')
    const b = new V('b')
    const c = new V('c')
    const grid = new Grid(a)
    grid.addView(b, 100, a, Direction.Right)
    grid.addView(c, 100, b, Direction.Right)
    // All three are siblings in the horizontal root; b and c have equal sizes.
    expect(grid.getLeafSize(b)).toBe(grid.getLeafSize(c))
  })
})

describe('Grid — container size + pixel resize', () => {
  it('resizeViewByDelta grows the leaf by the requested pixels and fires onDidChange', () => {
    const a = new V('a')
    const b = new V('b')
    const grid = new Grid(a)
    grid.addView(b, 200, a, Direction.Right)
    grid.setContainerSize({ width: 1000, height: 600 })
    const spy = vi.fn()
    grid.onDidChange(spy)

    expect(grid.resizeViewByDelta(a, 'width', 100)).toBe(true)

    // Two equal 500-flex leaves in a 1000px container: 1 flex == 1px.
    expect(grid.getLeafSize(a)).toBe(600)
    expect(grid.getLeafSize(b)).toBe(400)
    expect(grid.getViewSize(a)).toEqual({ width: 600, height: 600 })
    expect(spy).toHaveBeenCalledOnce()
  })

  it('clamps to the view minimum in pixels, not in flex units', () => {
    const a = new V('a')
    const b = new V('b')
    const grid = new Grid(a)
    grid.addView(b, 200, a, Direction.Right)
    // 600px container over 1000 flex → 1 flex == 0.6px, so the old flex-space
    // clamp (minimumWidth = 50 flex) would have stopped at 30px.
    grid.setContainerSize({ width: 600, height: 600 })

    expect(grid.resizeViewByDelta(a, 'width', -400)).toBe(true)

    expect(grid.getViewSize(a)?.width).toBeCloseTo(50)
    expect(grid.getViewSize(b)?.width).toBeCloseTo(550)
    expect(grid.getLeafSize(a)).toBeCloseTo(50 / 0.6)
  })

  it('stops at the sibling minimum instead of squashing it', () => {
    const a = new V('a')
    const b = new V('b')
    const grid = new Grid(a)
    grid.addView(b, 200, a, Direction.Right)
    grid.setContainerSize({ width: 600, height: 600 })

    expect(grid.resizeViewByDelta(a, 'width', 1000)).toBe(true)

    expect(grid.getViewSize(a)?.width).toBeCloseTo(550)
    expect(grid.getViewSize(b)?.width).toBeCloseTo(50)
  })

  it('keeps the divider movable when the container is narrower than both minimums', () => {
    const a = new V('a')
    const b = new V('b')
    const grid = new Grid(a)
    grid.addView(b, 200, a, Direction.Right)
    // 60px for two 50px minimums: no split of it can satisfy both, and the
    // container is to blame — freezing the divider at 30/30 would leave the
    // sash dead and the shortcut claiming an axis it never moves.
    grid.setContainerSize({ width: 60, height: 600 })

    expect(grid.resizeViewByDelta(a, 'width', 100)).toBe(true)

    expect(grid.getViewSize(a)?.width).toBeCloseTo(60)
    expect(grid.getViewSize(b)?.width).toBeCloseTo(0)

    expect(grid.resizeViewByDelta(a, 'width', -100)).toBe(true)

    expect(grid.getViewSize(a)?.width).toBeCloseTo(0)
    expect(grid.getViewSize(b)?.width).toBeCloseTo(60)
  })

  it('drags a sash in an over-constrained container too', () => {
    const a = new V('a')
    const b = new V('b')
    const grid = new Grid(a)
    grid.addView(b, 200, a, Direction.Right)
    grid.setContainerSize({ width: 60, height: 600 })

    grid.resizeSash(grid.root, 0, 12)

    expect(grid.getViewSize(a)?.width).toBeCloseTo(42)
    expect(grid.getViewSize(b)?.width).toBeCloseTo(18)
  })

  it('resizes without a container measurement is a no-op', () => {
    const a = new V('a')
    const b = new V('b')
    const grid = new Grid(a)
    grid.addView(b, 200, a, Direction.Right)
    const spy = vi.fn()
    grid.onDidChange(spy)

    // Handled (the split exists) but nothing can move without a measurement.
    expect(grid.resizeViewByDelta(a, 'width', 100)).toBe(true)
    expect(grid.getLeafSize(a)).toBe(500)
    expect(spy).not.toHaveBeenCalled()
  })

  it('setContainerSize itself never fires onDidChange', () => {
    const grid = new Grid(new V('a'))
    const spy = vi.fn()
    grid.onDidChange(spy)
    grid.setContainerSize({ width: 1000, height: 600 })
    grid.setContainerSize({ width: 0, height: 0 })
    expect(spy).not.toHaveBeenCalled()
    expect(grid.getContainerSize()).toEqual({ width: 0, height: 0 })
  })

  it('resizeViewByDelta with no split along the axis reports fallback', () => {
    const a = new V('a')
    const b = new V('b')
    const grid = new Grid(a)
    grid.addView(b, 200, a, Direction.Right)
    grid.setContainerSize({ width: 1000, height: 600 })
    const spy = vi.fn()
    grid.onDidChange(spy)

    expect(grid.resizeViewByDelta(a, 'height', 500)).toBe(false) // parent is horizontal
    expect(spy).not.toHaveBeenCalled()
  })

  it('resizeViewByDelta on a single-group grid reports fallback', () => {
    const a = new V('a')
    const grid = new Grid(a)
    grid.setContainerSize({ width: 1000, height: 600 })
    expect(grid.resizeViewByDelta(a, 'width', 100)).toBe(false)
    expect(grid.resizeViewByDelta(a, 'height', 100)).toBe(false)
  })

  it('getViewSize is undefined before a container measurement', () => {
    const a = new V('a')
    const grid = new Grid(a)
    expect(grid.getViewSize(a)).toBeUndefined()
    expect(grid.getContainerSize()).toBeUndefined()
  })
})

describe('Grid — serialize / deserialize', () => {
  it('round-trips a 2-leaf grid', () => {
    const a = new V('a')
    const b = new V('b')
    const grid = new Grid(a)
    grid.addView(b, 150, a, Direction.Right)
    const json = grid.serialize((v) => v.viewId)
    expect(json.root.type).toBe('branch')
    expect(json.root.children?.length).toBe(2)

    const restored = Grid.deserialize<V>(json, (data) => new V(data as string))
    expect(restored.getViews().map((v) => v.viewId)).toEqual(['a', 'b'])
  })

  it('round-trips a depth-2 nested grid preserving orientation', () => {
    const a = new V('a')
    const b = new V('b')
    const c = new V('c')
    const grid = new Grid(a, Orientation.Horizontal)
    grid.addView(b, 100, a, Direction.Right)
    grid.addView(c, 100, b, Direction.Down)
    const json = grid.serialize((v) => v.viewId)

    const restored = Grid.deserialize<V>(json, (data) => new V(data as string))
    expect(
      restored
        .getViews()
        .map((v) => v.viewId)
        .sort(),
    ).toEqual(['a', 'b', 'c'])
    expect(restored.orientation).toBe(Orientation.Horizontal)
  })

  it('serialized leaf nodes preserve sizes', () => {
    const a = new V('a')
    const b = new V('b')
    const grid = new Grid(a)
    grid.addView(b, 200, a, Direction.Right)
    grid.setContainerSize({ width: 1000, height: 600 })
    grid.resizeViewByDelta(a, 'width', 100)
    const json = grid.serialize((v) => v.viewId)
    const leafA = json.root.children?.find((c) => c.type === 'leaf' && c.data === 'a')
    // 1000px over 1000 flex units makes 1px == 1 flex, so a literal, not
    // `getLeafSize(a)` — that reads the very field serialization copied.
    expect(leafA?.size).toBe(600)

    const restored = Grid.deserialize<V>(json, (data) => new V(data as string))
    expect(restored.getViews().map((v) => restored.getLeafSize(v))).toEqual([600, 400])
  })
})

describe('Grid — resize on nested branches', () => {
  // Regression: for the layout Vertical(Horizontal(A, B), C) a height resize
  // requested through A (the keyboard path) must walk up past A's immediate
  // parent (Horizontal) to the first ancestor split that runs along the axis.
  // Looking only at the immediate parent made the request a silent no-op.

  it('walks up from the leaf to the split that runs along the axis', () => {
    const a = new V('a')
    const b = new V('b')
    const c = new V('c')
    const grid = new Grid(a)
    // Build Vertical( Horizontal(A,B), C )
    grid.addView(b, 200, a, Direction.Down) // Vertical(A, B) inside root
    grid.addView(c, 200, a, Direction.Right) // split A right: Horizontal(A,C) replaces A
    // Now tree is Root(Horizontal)[Vertical(Horizontal(A,C), B)]
    grid.setContainerSize({ width: 1000, height: 600 })
    const spy = vi.fn()
    grid.onDidChange(spy)
    const prevSizeB = grid.getLeafSize(b)
    const prevSizeA = grid.getLeafSize(a)

    expect(grid.resizeViewByDelta(a, 'height', 60)).toBe(true)

    // The row and B trade height (300px each in a 600px container); the row's
    // own horizontal split keeps its ratio.
    expect(spy).toHaveBeenCalledOnce()
    expect(grid.getLeafSize(b)).not.toBe(prevSizeB)
    expect(grid.getLeafSize(a)).toBe(prevSizeA)
    expect(grid.getViewSize(a)?.height).toBeCloseTo(360)
    expect(grid.getViewSize(b)?.height).toBeCloseTo(240)
  })

  /** Root(H)[ V( H(A,B), C ), D ] — a tree `addView` cannot express. */
  function nestedLayout() {
    const v = { a: new V('a'), b: new V('b'), c: new V('c'), d: new V('d') }
    const leaf = (data: keyof typeof v) => ({ type: 'leaf' as const, size: 500, data })
    const grid = new Grid(v.a)
    grid.rebuildFrom(
      {
        type: 'branch',
        size: 1,
        orientation: Orientation.Horizontal,
        children: [
          {
            type: 'branch',
            size: 500,
            orientation: Orientation.Vertical,
            children: [
              {
                type: 'branch',
                size: 500,
                orientation: Orientation.Horizontal,
                children: [leaf('a'), leaf('b')],
              },
              leaf('c'),
            ],
          },
          leaf('d'),
        ],
      },
      (data) => v[data as keyof typeof v],
    )
    grid.setContainerSize({ width: 1000, height: 600 })
    return { grid, v }
  }

  it('resizeSash on the inner split only moves that split', () => {
    const { grid, v } = nestedLayout()
    expect(grid.getViewSize(v.a)).toEqual({ width: 250, height: 300 })

    const vBranch = grid.root.children[0]
    if (!vBranch || vBranch.kind !== 'branch') throw new Error('expected a V branch')

    grid.resizeSash(vBranch, 0, 50)

    // The A|B row grew 50px taller, C gave the space up.
    expect(grid.getViewSize(v.a)?.height).toBeCloseTo(350)
    expect(grid.getViewSize(v.b)?.height).toBeCloseTo(350)
    expect(grid.getViewSize(v.c)?.height).toBeCloseTo(250)
    // The V|D split is untouched.
    expect(grid.getViewSize(v.d)?.width).toBeCloseTo(500)
  })

  it('resizeSash on the root split moves the column split, not an inner one', () => {
    // Regression: the A|B and the V|D splits both run horizontally, so resolving
    // the root sash through its leftmost leaf (A) picks the inner A|B branch and
    // silently resizes the wrong divider.
    const { grid, v } = nestedLayout()

    grid.resizeSash(grid.root, 0, 50)

    expect(grid.getViewSize(v.d)?.width).toBeCloseTo(450)
    expect(grid.getViewSize(v.a)?.width).toBeCloseTo(275)
    expect(grid.getViewSize(v.a)?.height).toBeCloseTo(300)
    expect(grid.getViewSize(v.c)?.height).toBeCloseTo(300)
  })

  it('the keyboard path resolves the same split as the sash', () => {
    const viaSash = nestedLayout()
    const viaKeyboard = nestedLayout()
    const vBranch = viaSash.grid.root.children[0]
    if (!vBranch || vBranch.kind !== 'branch') throw new Error('expected a V branch')

    viaSash.grid.resizeSash(vBranch, 0, 50)
    expect(viaKeyboard.grid.resizeViewByDelta(viaKeyboard.v.a, 'height', 50)).toBe(true)

    expect(viaKeyboard.grid.getLeafSize(viaKeyboard.v.a)).toBeCloseTo(
      viaSash.grid.getLeafSize(viaSash.v.a),
    )
    expect(viaKeyboard.grid.getLeafSize(viaKeyboard.v.b)).toBeCloseTo(
      viaSash.grid.getLeafSize(viaSash.v.b),
    )
    expect(viaKeyboard.grid.getLeafSize(viaKeyboard.v.c)).toBeCloseTo(
      viaSash.grid.getLeafSize(viaSash.v.c),
    )
    expect(viaKeyboard.grid.getLeafSize(viaKeyboard.v.d)).toBeCloseTo(
      viaSash.grid.getLeafSize(viaSash.v.d),
    )
  })
})

describe('Grid — rebuildFrom', () => {
  it('replaces the tree with the serialized structure', () => {
    const a = new V('a')
    const b = new V('b')
    const c = new V('c')
    const grid = new Grid(a)
    grid.addView(b, 200, a, Direction.Down)
    grid.addView(c, 200, a, Direction.Right)
    // Serialize, then wipe by rebuilding with new view instances.
    const json = grid.serialize((v) => v.viewId)
    const d = new V('d')
    const e = new V('e')
    const f = new V('f')
    const views = [d, e, f]
    let idx = 0
    grid.rebuildFrom(json.root, () => views[idx++]!)
    expect(grid.getViews()).toEqual([d, e, f])
  })

  it('fires onDidChange exactly once', () => {
    const a = new V('a')
    const b = new V('b')
    const grid = new Grid(a)
    grid.addView(b, 200, a, Direction.Right)
    const json = grid.serialize((v) => v.viewId)
    const spy = vi.fn()
    grid.onDidChange(spy)
    let idx = 0
    const fresh = [new V('x'), new V('y')]
    grid.rebuildFrom(json.root, () => fresh[idx++]!)
    expect(spy).toHaveBeenCalledOnce()
  })

  it('correctly restores a 3-leaf nested layout — the editor-group drag regression', () => {
    // Reproduces: after dragging an editor to the top row the layout becomes
    // Root(Horizontal)[Vertical(Horizontal(G1,G3), G2)].  A previous restore
    // approach using sequential addView calls reconstructed it incorrectly as
    // Root(Horizontal)[G1, Vertical(G3,G2)] — two columns, right has two rows.
    const g1 = new V('g1')
    const g2 = new V('g2')
    const g3 = new V('g3')
    const grid = new Grid(g1)
    // Add g2 below g1 → Root(Horizontal)[Vertical(G1,G2)]
    grid.addView(g2, 200, g1, Direction.Down)
    // Add g3 to the right of g1 → Root(Horizontal)[Vertical(Horizontal(G1,G3),G2)]
    grid.addView(g3, 200, g1, Direction.Right)

    const json = grid.serialize((v) => v.viewId)

    // Rebuild from the serialized data with fresh view instances.
    const r1 = new V('r1')
    const r2 = new V('r2')
    const r3 = new V('r3')
    const replacements = [r1, r2, r3]
    let ri = 0
    grid.rebuildFrom(json.root, () => replacements[ri++]!)

    // The vertical branch (outer) should have two children:
    //   child[0] — horizontal branch with r1 and r2 (the top row)
    //   child[1] — leaf r3 (the bottom row)
    // NOT: horizontal root with r1 and vertical(r2,r3).
    expect(grid.getViews()).toEqual([r1, r2, r3])
    const root = grid.root
    // Root has one child which is the outer Vertical branch.
    expect(root.children).toHaveLength(1)
    const outer = root.children[0]!
    expect(outer.kind).toBe('branch')
    if (outer.kind === 'branch') {
      expect(outer.orientation).toBe(Orientation.Vertical)
      expect(outer.children).toHaveLength(2)
      const topRow = outer.children[0]!
      expect(topRow.kind).toBe('branch')
      if (topRow.kind === 'branch') {
        expect(topRow.orientation).toBe(Orientation.Horizontal)
        expect(topRow.children).toHaveLength(2)
      }
      expect(outer.children[1]!.kind).toBe('leaf')
    }
  })
})
