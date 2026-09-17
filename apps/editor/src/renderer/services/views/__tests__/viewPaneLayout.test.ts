import { describe, expect, it } from 'vitest'
import {
  computeResizeSizes,
  computeToggleSizes,
  initialPaneSize,
  VIEW_HEADER_SIZE,
  VIEW_OPEN_MIN,
} from '../viewPaneLayout.js'

describe('computeToggleSizes', () => {
  it('collapsing hands the freed space to the bottom-most open pane', () => {
    // VSCode SplitView greedy resize: maxSize = Infinity absorbs it all.
    const result = computeToggleSizes({
      sizes: [300, 300, 300],
      collapsed: [false, true, false],
      toggledIndex: 1,
    })
    expect(result).toEqual([300, VIEW_HEADER_SIZE, 900 - 300 - VIEW_HEADER_SIZE])
  })

  it('collapsing the last pane hands the space to the pane above', () => {
    const result = computeToggleSizes({
      sizes: [500, 400],
      collapsed: [false, true],
      toggledIndex: 1,
    })
    expect(result).toEqual([900 - VIEW_HEADER_SIZE, VIEW_HEADER_SIZE])
  })

  it('expanding restores the persisted size, taken from the bottom open pane', () => {
    const result = computeToggleSizes({
      sizes: [VIEW_HEADER_SIZE, 872],
      collapsed: [false, false],
      toggledIndex: 0,
      restoreSize: 400,
    })
    expect(result).toEqual([400, 500])
  })

  it('expanding without a persisted size falls back to an even share', () => {
    const result = computeToggleSizes({
      sizes: [VIEW_HEADER_SIZE, 872],
      collapsed: [false, false],
      toggledIndex: 0,
    })
    expect(result).toEqual([450, 450])
  })

  it('donors bottom out at OPEN_MIN and the expanding pane settles for the rest', () => {
    const result = computeToggleSizes({
      sizes: [VIEW_HEADER_SIZE, 200],
      collapsed: [false, false],
      toggledIndex: 0,
      restoreSize: 300,
    })
    // total 228; donor gives 200 - 88 = 112, the rest comes off the restore target.
    expect(result).toEqual([228 - VIEW_OPEN_MIN, VIEW_OPEN_MIN])
  })

  it('returns undefined when every pane is collapsed', () => {
    expect(
      computeToggleSizes({
        sizes: [VIEW_HEADER_SIZE, 500],
        collapsed: [true, true],
        toggledIndex: 1,
      }),
    ).toBeUndefined()
  })

  it('returns undefined on mismatched input', () => {
    expect(
      computeToggleSizes({ sizes: [100], collapsed: [false, false], toggledIndex: 0 }),
    ).toBeUndefined()
    expect(
      computeToggleSizes({ sizes: [100, 100], collapsed: [false, false], toggledIndex: 5 }),
    ).toBeUndefined()
    expect(computeToggleSizes({ sizes: [], collapsed: [], toggledIndex: 0 })).toBeUndefined()
  })
})

describe('computeResizeSizes', () => {
  const sum = (sizes: readonly number[]) => sizes.reduce((total, size) => total + size, 0)

  it('growing borrows from the pane below, keeping the container total', () => {
    const sizes = [300, 300]
    const result = computeResizeSizes({
      sizes,
      collapsed: [false, false],
      resizedIndex: 0,
      deltaPx: 50,
    })
    expect(result).toEqual([350, 250])
    expect(sum(result!)).toBe(sum(sizes))
    expect(sizes).toEqual([300, 300])
  })

  it('growing spills over to the next pane down once the nearest bottoms out', () => {
    expect(
      computeResizeSizes({
        sizes: [300, VIEW_OPEN_MIN, 300],
        collapsed: [false, false, false],
        resizedIndex: 0,
        deltaPx: 50,
      }),
    ).toEqual([350, VIEW_OPEN_MIN, 250])
  })

  it('growing borrows from the pane above, nearest first', () => {
    // Above = [index 1, index 0]; index 1 can cover the whole step, so index 0 stays put.
    expect(
      computeResizeSizes({
        sizes: [300, 200, VIEW_OPEN_MIN],
        collapsed: [false, false, false],
        resizedIndex: 2,
        deltaPx: 50,
      }),
    ).toEqual([300, 150, 138])
  })

  it('grows the bottom pane from the pane above', () => {
    expect(
      computeResizeSizes({
        sizes: [300, 300],
        collapsed: [false, false],
        resizedIndex: 1,
        deltaPx: 50,
      }),
    ).toEqual([250, 350])
  })

  it('applies a partial delta when the donors bottom out', () => {
    // The only donor can give 100 - 88 = 12 of the requested 50.
    expect(
      computeResizeSizes({
        sizes: [150, 100],
        collapsed: [false, false],
        resizedIndex: 0,
        deltaPx: 50,
      }),
    ).toEqual([162, VIEW_OPEN_MIN])
  })

  it('never touches a collapsed pane', () => {
    expect(
      computeResizeSizes({
        sizes: [300, VIEW_HEADER_SIZE, 300],
        collapsed: [false, true, false],
        resizedIndex: 0,
        deltaPx: 50,
      }),
    ).toEqual([350, VIEW_HEADER_SIZE, 250])
  })

  it('returns undefined when no pixel can move', () => {
    // Every neighbour is collapsed, so there is no one to borrow from.
    expect(
      computeResizeSizes({
        sizes: [300, VIEW_HEADER_SIZE],
        collapsed: [false, true],
        resizedIndex: 0,
        deltaPx: 50,
      }),
    ).toBeUndefined()
    // The only neighbour is already at its floor.
    expect(
      computeResizeSizes({
        sizes: [300, VIEW_OPEN_MIN],
        collapsed: [false, false],
        resizedIndex: 0,
        deltaPx: 50,
      }),
    ).toBeUndefined()
  })

  it('shrinking hands the pixels to the pane below', () => {
    expect(
      computeResizeSizes({
        sizes: [300, 300],
        collapsed: [false, false],
        resizedIndex: 0,
        deltaPx: -50,
      }),
    ).toEqual([250, 350])
  })

  it('shrinking falls back to the pane above when there is none below', () => {
    expect(
      computeResizeSizes({
        sizes: [300, 300],
        collapsed: [false, false],
        resizedIndex: 1,
        deltaPx: -50,
      }),
    ).toEqual([350, 250])
  })

  it('shrinking stops at the pane floor', () => {
    expect(
      computeResizeSizes({
        sizes: [100, 300],
        collapsed: [false, false],
        resizedIndex: 0,
        deltaPx: -50,
      }),
    ).toEqual([VIEW_OPEN_MIN, 312])
  })

  it('returns undefined when the pane is already at its floor', () => {
    expect(
      computeResizeSizes({
        sizes: [VIEW_OPEN_MIN, 300],
        collapsed: [false, false],
        resizedIndex: 0,
        deltaPx: -50,
      }),
    ).toBeUndefined()
  })

  it('returns undefined on bad input', () => {
    expect(
      computeResizeSizes({ sizes: [100], collapsed: [false, false], resizedIndex: 0, deltaPx: 50 }),
    ).toBeUndefined()
    expect(
      computeResizeSizes({ sizes: [], collapsed: [], resizedIndex: 0, deltaPx: 50 }),
    ).toBeUndefined()
    expect(
      computeResizeSizes({
        sizes: [100, 100],
        collapsed: [false, false],
        resizedIndex: 5,
        deltaPx: 50,
      }),
    ).toBeUndefined()
    expect(
      computeResizeSizes({
        sizes: [100, 100],
        collapsed: [false, false],
        resizedIndex: 0,
        deltaPx: 0,
      }),
    ).toBeUndefined()
    // A collapsed pane has no body left to resize.
    expect(
      computeResizeSizes({
        sizes: [100, 100],
        collapsed: [true, false],
        resizedIndex: 0,
        deltaPx: 50,
      }),
    ).toBeUndefined()
  })
})

describe('initialPaneSize', () => {
  it('gives collapsed panes the header size', () => {
    expect(initialPaneSize(true, 500)).toBe(VIEW_HEADER_SIZE)
  })

  it('restores the stored size for expanded panes, clamped to OPEN_MIN', () => {
    expect(initialPaneSize(false, 500)).toBe(500)
    expect(initialPaneSize(false, 10)).toBe(VIEW_OPEN_MIN)
  })

  it('returns undefined without a stored size so Allotment splits evenly', () => {
    expect(initialPaneSize(false, undefined)).toBeUndefined()
  })
})
