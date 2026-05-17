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

describe('Grid — resizeView', () => {
  it('resizeView updates the leaf size and fires onDidChange', () => {
    const a = new V('a')
    const b = new V('b')
    const grid = new Grid(a)
    grid.addView(b, 200, a, Direction.Right)
    const spy = vi.fn()
    grid.onDidChange(spy)
    grid.resizeView(a, { width: 300 })
    expect(grid.getLeafSize(a)).toBe(300)
    expect(spy).toHaveBeenCalledOnce()
  })

  it('resizeView clamps to the view minimum', () => {
    const a = new V('a')
    const b = new V('b')
    const grid = new Grid(a)
    grid.addView(b, 200, a, Direction.Right)
    grid.resizeView(a, { width: 10 })
    expect(grid.getLeafSize(a)).toBe(a.minimumWidth)
  })

  it('resizeView with no relevant axis is a no-op', () => {
    const a = new V('a')
    const b = new V('b')
    const grid = new Grid(a)
    grid.addView(b, 200, a, Direction.Right)
    const spy = vi.fn()
    grid.onDidChange(spy)
    grid.resizeView(a, { height: 500 }) // parent is horizontal
    expect(spy).not.toHaveBeenCalled()
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
    grid.resizeView(a, { width: 250 })
    const json = grid.serialize((v) => v.viewId)
    const leafA = json.root.children?.find((c) => c.type === 'leaf' && c.data === 'a')
    expect(leafA?.size).toBe(250)
  })
})
