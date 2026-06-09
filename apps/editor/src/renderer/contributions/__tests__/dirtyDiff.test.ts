import { describe, expect, it } from 'vitest'
import { computeDirtyDiffRegions } from '../dirtyDiff.js'

describe('computeDirtyDiffRegions', () => {
  it('reports no regions when the document matches HEAD', () => {
    const text = 'a\nb\nc\n'
    expect(computeDirtyDiffRegions(text, text)).toEqual([])
  })

  it('classifies a pure insertion as added', () => {
    const head = 'a\nc\n'
    const current = 'a\nb\nc\n'
    expect(computeDirtyDiffRegions(head, current)).toEqual([
      { startLine: 2, endLine: 2, kind: 'added' },
    ])
  })

  it('classifies a replaced line as modified', () => {
    const head = 'a\nb\nc\n'
    const current = 'a\nB\nc\n'
    expect(computeDirtyDiffRegions(head, current)).toEqual([
      { startLine: 2, endLine: 2, kind: 'modified' },
    ])
  })

  it('classifies a pure deletion as deleted, anchored to the preceding line', () => {
    const head = 'a\nb\nc\n'
    const current = 'a\nc\n'
    expect(computeDirtyDiffRegions(head, current)).toEqual([
      { startLine: 1, endLine: 1, kind: 'deleted' },
    ])
  })

  it('anchors a deletion at the top of the file to line 1', () => {
    const head = 'a\nb\nc\n'
    const current = 'b\nc\n'
    expect(computeDirtyDiffRegions(head, current)).toEqual([
      { startLine: 1, endLine: 1, kind: 'deleted' },
    ])
  })

  it('treats a brand-new file (empty HEAD) as one added region', () => {
    const current = 'a\nb\nc\n'
    expect(computeDirtyDiffRegions('', current)).toEqual([
      { startLine: 1, endLine: 3, kind: 'added' },
    ])
  })

  it('handles multiple independent hunks', () => {
    const head = 'a\nb\nc\nd\ne\n'
    const current = 'a\nX\nc\nd\ne\nf\n'
    expect(computeDirtyDiffRegions(head, current)).toEqual([
      { startLine: 2, endLine: 2, kind: 'modified' },
      { startLine: 6, endLine: 6, kind: 'added' },
    ])
  })

  it('ignores CRLF vs LF differences', () => {
    const head = 'a\r\nb\r\nc\r\n'
    const current = 'a\nb\nc\n'
    expect(computeDirtyDiffRegions(head, current)).toEqual([])
  })
})
