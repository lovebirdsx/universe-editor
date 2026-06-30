import { describe, expect, it } from 'vitest'
import type { DirtyDiffRegion } from '../../../contributions/dirtyDiff.js'
import { findAdjacentChange } from '../DirtyDiffNavigationService.js'

const region = (startLine: number, endLine = startLine): DirtyDiffRegion => ({
  startLine,
  endLine,
  originalStartLine: startLine,
  originalEndLine: endLine,
  kind: 'modified',
})

describe('findAdjacentChange', () => {
  const regions = [region(5, 6), region(10), region(20, 22)]

  it('returns undefined when there are no regions', () => {
    expect(findAdjacentChange([], 1, 'next')).toBeUndefined()
    expect(findAdjacentChange([], 1, 'previous')).toBeUndefined()
  })

  it('next picks the first region starting below the cursor', () => {
    expect(findAdjacentChange(regions, 1, 'next')).toBe(regions[0])
    expect(findAdjacentChange(regions, 5, 'next')).toBe(regions[1])
    expect(findAdjacentChange(regions, 10, 'next')).toBe(regions[2])
  })

  it('next wraps to the first region past the last change', () => {
    expect(findAdjacentChange(regions, 20, 'next')).toBe(regions[0])
    expect(findAdjacentChange(regions, 999, 'next')).toBe(regions[0])
  })

  it('previous picks the last region starting above the cursor', () => {
    expect(findAdjacentChange(regions, 999, 'previous')).toBe(regions[2])
    expect(findAdjacentChange(regions, 20, 'previous')).toBe(regions[1])
    expect(findAdjacentChange(regions, 10, 'previous')).toBe(regions[0])
  })

  it('previous wraps to the last region before the first change', () => {
    expect(findAdjacentChange(regions, 5, 'previous')).toBe(regions[2])
    expect(findAdjacentChange(regions, 1, 'previous')).toBe(regions[2])
  })
})
