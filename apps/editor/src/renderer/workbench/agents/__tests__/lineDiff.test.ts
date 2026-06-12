/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { computeLineDiff } from '../lineDiff.js'

describe('computeLineDiff', () => {
  it('returns empty for two empty strings', () => {
    expect(computeLineDiff('', '')).toEqual([])
  })

  it('marks all lines added for new file', () => {
    expect(computeLineDiff('', 'a\nb\n')).toEqual([
      { kind: 'add', text: 'a' },
      { kind: 'add', text: 'b' },
    ])
  })

  it('marks all lines deleted when target is empty', () => {
    expect(computeLineDiff('x\ny', '')).toEqual([
      { kind: 'del', text: 'x' },
      { kind: 'del', text: 'y' },
    ])
  })

  it('keeps identical lines as context', () => {
    expect(computeLineDiff('a\nb\nc', 'a\nb\nc')).toEqual([
      { kind: 'ctx', text: 'a' },
      { kind: 'ctx', text: 'b' },
      { kind: 'ctx', text: 'c' },
    ])
  })

  it('detects a single-line change as del + add', () => {
    const result = computeLineDiff('a\nB\nc', 'a\nb\nc')
    expect(result).toEqual([
      { kind: 'ctx', text: 'a' },
      { kind: 'del', text: 'B' },
      { kind: 'add', text: 'b' },
      { kind: 'ctx', text: 'c' },
    ])
  })

  it('handles insertion in the middle', () => {
    const result = computeLineDiff('a\nc', 'a\nb\nc')
    expect(result).toEqual([
      { kind: 'ctx', text: 'a' },
      { kind: 'add', text: 'b' },
      { kind: 'ctx', text: 'c' },
    ])
  })

  it('ignores a single trailing newline', () => {
    expect(computeLineDiff('a\n', 'a\n')).toEqual([{ kind: 'ctx', text: 'a' }])
  })

  it('emits a common prefix and suffix as context around a middle change', () => {
    const result = computeLineDiff('p\nq\nX\nr\ns', 'p\nq\nY\nr\ns')
    expect(result).toEqual([
      { kind: 'ctx', text: 'p' },
      { kind: 'ctx', text: 'q' },
      { kind: 'del', text: 'X' },
      { kind: 'add', text: 'Y' },
      { kind: 'ctx', text: 'r' },
      { kind: 'ctx', text: 's' },
    ])
  })

  it('orders deletions before insertions within a replaced block', () => {
    const result = computeLineDiff('a\nB\nC\nd', 'a\nx\ny\nd')
    expect(result).toEqual([
      { kind: 'ctx', text: 'a' },
      { kind: 'del', text: 'B' },
      { kind: 'del', text: 'C' },
      { kind: 'add', text: 'x' },
      { kind: 'add', text: 'y' },
      { kind: 'ctx', text: 'd' },
    ])
  })

  it('diffs a large near-identical pair without the O(m*n) full matrix', () => {
    // 20k identical lines with one changed line in the middle: the old full DP
    // would allocate ~20k² cells and stall; prefix/suffix trimming keeps it O(n).
    const lines = Array.from({ length: 20_000 }, (_, i) => `line ${i}`)
    const oldText = lines.join('\n')
    const changed = [...lines]
    changed[10_000] = 'CHANGED'
    const result = computeLineDiff(oldText, changed.join('\n'))
    expect(result.filter((l) => l.kind !== 'ctx')).toEqual([
      { kind: 'del', text: 'line 10000' },
      { kind: 'add', text: 'CHANGED' },
    ])
    expect(result).toHaveLength(20_001)
  })

  it('diffs a large file with edits scattered at top and bottom in O(ND)', () => {
    // The prefix/suffix fast path can't trim this: edits sit at both ends, so the
    // changed middle still spans the whole file. Myers stays cheap because cost
    // scales with the (tiny) edit distance, not the file size — this is the case
    // the earlier prefix-trim-only fix still stalled on.
    const lines = Array.from({ length: 20_000 }, (_, i) => `line ${i}`)
    const changed = [...lines]
    changed[5] = 'TOP EDIT'
    changed[19_995] = 'BOTTOM EDIT'
    const result = computeLineDiff(lines.join('\n'), changed.join('\n'))
    expect(result.filter((l) => l.kind !== 'ctx')).toEqual([
      { kind: 'del', text: 'line 5' },
      { kind: 'add', text: 'TOP EDIT' },
      { kind: 'del', text: 'line 19995' },
      { kind: 'add', text: 'BOTTOM EDIT' },
    ])
    expect(result).toHaveLength(20_002)
  })
})
