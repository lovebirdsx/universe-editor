/*---------------------------------------------------------------------------------------------
 *  Regression (ENAMETOOLONG): a Perforce changelist with tens of thousands of
 *  files expanded `reconcile -n`/`where` into a single over-long argv, so
 *  `spawn` threw ENAMETOOLONG (surfaced as an unhandled rejection in the
 *  extension host). Path lists must be split into command-line-sized batches.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { chunkByLength, MAX_PATH_ARGS_CHARS } from '../p4Service.js'

describe('chunkByLength', () => {
  it('returns no batches for an empty list', () => {
    expect(chunkByLength([])).toEqual([])
  })

  it('keeps a small list in a single batch', () => {
    const paths = ['a', 'b', 'c']
    expect(chunkByLength(paths)).toEqual([paths])
  })

  it('splits so each batch stays within the char budget', () => {
    // 10 paths of 100 chars each with a small budget → multiple batches.
    const paths = Array.from({ length: 10 }, (_, i) => `${'p'.repeat(99)}${i}`)
    const batches = chunkByLength(paths, 250)
    expect(batches.length).toBeGreaterThan(1)
    // Every batch's joined length (path + one separator each) is within budget.
    for (const batch of batches) {
      const len = batch.reduce((n, p) => n + p.length + 1, 0)
      expect(len).toBeLessThanOrEqual(250)
    }
    // No path is lost or reordered.
    expect(batches.flat()).toEqual(paths)
  })

  it('never loses a path when many exceed the default budget', () => {
    const paths = Array.from({ length: 70000 }, (_, i) => `//depot/game/assets/file_${i}.uasset`)
    const batches = chunkByLength(paths)
    expect(batches.flat()).toHaveLength(70000)
    for (const batch of batches) {
      const len = batch.reduce((n, p) => n + p.length + 1, 0)
      expect(len).toBeLessThanOrEqual(MAX_PATH_ARGS_CHARS)
    }
  })

  it('gives an over-long single path its own batch rather than dropping it', () => {
    const huge = 'x'.repeat(MAX_PATH_ARGS_CHARS * 2)
    const batches = chunkByLength(['short', huge, 'tail'])
    expect(batches.flat()).toEqual(['short', huge, 'tail'])
    // The huge path is isolated in its own batch.
    expect(batches.some((b) => b.length === 1 && b[0] === huge)).toBe(true)
  })
})
