import { describe, expect, it } from 'vitest'
import { computeGraphLayout, type GraphCommitInput, type GraphGrid } from '../graphLayout.js'

const GRID: GraphGrid = { x: 14, y: 24, offsetX: 12, offsetY: 12 }

function layout(commits: GraphCommitInput[], head: string | null = null) {
  return computeGraphLayout(commits, head, { grid: GRID })
}

describe('computeGraphLayout', () => {
  it('returns an empty layout for no commits', () => {
    const result = layout([])
    expect(result.vertices).toEqual([])
    expect(result.paths).toEqual([])
    expect(result.laneCount).toBe(0)
    expect(result.height).toBe(0)
  })

  it('places a linear history in a single lane with one colour', () => {
    const result = layout(
      [
        { hash: 'a', parents: ['b'] },
        { hash: 'b', parents: ['c'] },
        { hash: 'c', parents: [] },
      ],
      'a',
    )
    expect(result.vertices).toHaveLength(3)
    for (const v of result.vertices) {
      expect(v.lane).toBe(0)
      expect(v.colour).toBe(0)
      expect(v.cx).toBe(GRID.offsetX)
    }
    expect(result.vertices[0]!.isCurrent).toBe(true)
    expect(result.vertices[1]!.isCurrent).toBe(false)
    expect(result.paths.length).toBeGreaterThanOrEqual(1)
  })

  it('positions commit rows by index (cy = id*y + offsetY)', () => {
    const result = layout([
      { hash: 'a', parents: ['b'] },
      { hash: 'b', parents: [] },
    ])
    expect(result.vertices[0]!.cy).toBe(GRID.offsetY)
    expect(result.vertices[1]!.cy).toBe(GRID.y + GRID.offsetY)
  })

  it('spreads a fork/merge across multiple lanes and colours', () => {
    const result = layout(
      [
        { hash: 'm', parents: ['a', 'b'] },
        { hash: 'a', parents: ['c'] },
        { hash: 'b', parents: ['c'] },
        { hash: 'c', parents: [] },
      ],
      'm',
    )
    expect(result.vertices).toHaveLength(4)
    expect(result.laneCount).toBeGreaterThanOrEqual(2)
    // At least two distinct colours are used once the history forks.
    const colours = new Set(result.vertices.map((v) => v.colour))
    expect(colours.size).toBeGreaterThanOrEqual(2)
    expect(result.width).toBeGreaterThan(2 * GRID.offsetX)
  })

  it('marks stash nodes', () => {
    const result = layout([
      { hash: 's', parents: ['a'], isStash: true },
      { hash: 'a', parents: [] },
    ])
    expect(result.vertices[0]!.isStash).toBe(true)
    expect(result.vertices[1]!.isStash).toBe(false)
  })

  it('shifts rows after an inline expansion gap', () => {
    const commits: GraphCommitInput[] = [
      { hash: 'a', parents: ['b'] },
      { hash: 'b', parents: ['c'] },
      { hash: 'c', parents: [] },
    ]
    const base = computeGraphLayout(commits, 'a', { grid: GRID })
    const expanded = computeGraphLayout(commits, 'a', {
      grid: GRID,
      expand: { afterIndex: 0, height: 300 },
    })
    // Total height grows by exactly the gap.
    expect(expanded.height).toBe(base.height + 300)
    // The anchor row (index 0) is unchanged; rows after it shift down by the gap.
    expect(expanded.vertices[0]!.cy).toBe(base.vertices[0]!.cy)
    expect(expanded.vertices[1]!.cy).toBe(base.vertices[1]!.cy + 300)
    expect(expanded.vertices[2]!.cy).toBe(base.vertices[2]!.cy + 300)
  })
})
