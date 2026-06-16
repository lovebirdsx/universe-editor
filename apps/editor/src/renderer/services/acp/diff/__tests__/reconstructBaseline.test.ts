/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect } from 'vitest'
import { reconstructBaseline, type DiffBatch } from '../reconstructBaseline.js'

/** Helper: a single-batch reconstruction. */
function single(
  current: string,
  hunks: DiffBatch['hunks'],
): ReturnType<typeof reconstructBaseline> {
  return reconstructBaseline(current, [{ hunks }])
}

describe('reconstructBaseline', () => {
  it('rebuilds baseline from a single replacement hunk', () => {
    // current has "new text" at line 6; baseline had "old text".
    const current = ['a', 'b', 'c', 'd', 'context before', 'new text', 'context after'].join('\n')
    const { baseline, degraded } = single(current, [
      {
        oldStart: 5,
        oldLines: 3,
        newStart: 5,
        newLines: 3,
        lines: [' context before', '-old text', '+new text', ' context after'],
      },
    ])
    expect(degraded).toBe(false)
    expect(baseline).toBe(
      ['a', 'b', 'c', 'd', 'context before', 'old text', 'context after'].join('\n'),
    )
  })

  it('treats an empty baseline (file creation) correctly', () => {
    // Write created the file: every line is added, no "before" lines.
    const current = ['line1', 'line2', 'line3'].join('\n')
    const { baseline, degraded } = single(current, [
      {
        oldStart: 0,
        oldLines: 0,
        newStart: 1,
        newLines: 3,
        lines: ['+line1', '+line2', '+line3'],
      },
    ])
    expect(degraded).toBe(false)
    expect(baseline).toBe('')
  })

  it('handles a pure insertion (added lines, context preserved)', () => {
    const current = ['head', 'inserted', 'tail'].join('\n')
    const { baseline, degraded } = single(current, [
      {
        oldStart: 1,
        oldLines: 2,
        newStart: 1,
        newLines: 3,
        lines: [' head', '+inserted', ' tail'],
      },
    ])
    expect(degraded).toBe(false)
    expect(baseline).toBe(['head', 'tail'].join('\n'))
  })

  it('handles a pure deletion (removed lines come back)', () => {
    const current = ['head', 'tail'].join('\n')
    const { baseline, degraded } = single(current, [
      {
        oldStart: 1,
        oldLines: 3,
        newStart: 1,
        newLines: 2,
        lines: [' head', '-removed', ' tail'],
      },
    ])
    expect(degraded).toBe(false)
    expect(baseline).toBe(['head', 'removed', 'tail'].join('\n'))
  })

  it('un-applies multiple hunks within one batch (bottom-up)', () => {
    const current = ['ctxA', 'NEW1', 'ctxB', 'mid1', 'mid2', 'ctxC', 'NEW2', 'ctxD'].join('\n')
    const { baseline, degraded } = single(current, [
      {
        oldStart: 1,
        oldLines: 3,
        newStart: 1,
        newLines: 3,
        lines: [' ctxA', '-OLD1', '+NEW1', ' ctxB'],
      },
      {
        oldStart: 6,
        oldLines: 3,
        newStart: 6,
        newLines: 3,
        lines: [' ctxC', '-OLD2', '+NEW2', ' ctxD'],
      },
    ])
    expect(degraded).toBe(false)
    expect(baseline).toBe(
      ['ctxA', 'OLD1', 'ctxB', 'mid1', 'mid2', 'ctxC', 'OLD2', 'ctxD'].join('\n'),
    )
  })

  it('un-applies multiple batches newest-first', () => {
    // Batch 1 turned X→Y, batch 2 turned Y→Z. current has Z; baseline is X.
    const current = ['p', 'Z', 'q'].join('\n')
    const { baseline, degraded } = reconstructBaseline(current, [
      {
        hunks: [
          { oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' p', '-X', '+Y', ' q'] },
        ],
      },
      {
        hunks: [
          { oldStart: 1, oldLines: 3, newStart: 1, newLines: 3, lines: [' p', '-Y', '+Z', ' q'] },
        ],
      },
    ])
    expect(degraded).toBe(false)
    expect(baseline).toBe(['p', 'X', 'q'].join('\n'))
  })

  it('handles replaceAll: multiple hunks replacing the same token', () => {
    const current = ['bar', 'keep', 'bar', 'end'].join('\n')
    const { baseline, degraded } = single(current, [
      { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-foo', '+bar'] },
      { oldStart: 3, oldLines: 1, newStart: 3, newLines: 1, lines: ['-foo', '+bar'] },
    ])
    expect(degraded).toBe(false)
    expect(baseline).toBe(['foo', 'keep', 'foo', 'end'].join('\n'))
  })

  it('locates a hunk by text when line numbers drifted', () => {
    // newStart says 2, but the block actually sits at line 4 (earlier insertions
    // shifted it). Text fallback should still find it.
    const current = ['x', 'y', 'z', 'context', 'new', 'after'].join('\n')
    const { baseline, degraded } = single(current, [
      {
        oldStart: 2,
        oldLines: 3,
        newStart: 2,
        newLines: 3,
        lines: [' context', '-old', '+new', ' after'],
      },
    ])
    expect(degraded).toBe(false)
    expect(baseline).toBe(['x', 'y', 'z', 'context', 'old', 'after'].join('\n'))
  })

  it('marks degraded when a hunk cannot be located', () => {
    const current = ['totally', 'different', 'content'].join('\n')
    const { degraded } = single(current, [
      {
        oldStart: 1,
        oldLines: 3,
        newStart: 1,
        newLines: 3,
        lines: [' ctx', '-old', '+expected-but-missing', ' ctx2'],
      },
    ])
    expect(degraded).toBe(true)
  })

  it('returns current unchanged when there are no batches', () => {
    const current = ['a', 'b'].join('\n')
    const { baseline, degraded } = reconstructBaseline(current, [])
    expect(degraded).toBe(false)
    expect(baseline).toBe(current)
  })
})
