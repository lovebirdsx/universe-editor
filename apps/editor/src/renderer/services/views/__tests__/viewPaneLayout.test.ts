import { describe, expect, it } from 'vitest'
import {
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
