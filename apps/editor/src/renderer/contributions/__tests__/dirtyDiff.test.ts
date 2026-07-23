import { describe, expect, it } from 'vitest'
import {
  computeDirtyDiffRegions,
  computeDirtyDiffRegionsFromLines,
  toDiffLines,
  trimTrailingEmptyLine,
} from '../dirtyDiff.js'

describe('computeDirtyDiffRegions', () => {
  it('reports no regions when the document matches HEAD', () => {
    const text = 'a\nb\nc\n'
    expect(computeDirtyDiffRegions(text, text)).toEqual([])
  })

  it('classifies a pure insertion as added', () => {
    const head = 'a\nc\n'
    const current = 'a\nb\nc\n'
    expect(computeDirtyDiffRegions(head, current)).toEqual([
      { startLine: 2, endLine: 2, originalStartLine: 1, originalEndLine: 0, kind: 'added' },
    ])
  })

  it('classifies a replaced line as modified', () => {
    const head = 'a\nb\nc\n'
    const current = 'a\nB\nc\n'
    expect(computeDirtyDiffRegions(head, current)).toEqual([
      { startLine: 2, endLine: 2, originalStartLine: 2, originalEndLine: 2, kind: 'modified' },
    ])
  })

  it('classifies a pure deletion as deleted, anchored to the preceding line', () => {
    const head = 'a\nb\nc\n'
    const current = 'a\nc\n'
    expect(computeDirtyDiffRegions(head, current)).toEqual([
      { startLine: 1, endLine: 1, originalStartLine: 2, originalEndLine: 2, kind: 'deleted' },
    ])
  })

  it('anchors a deletion at the top of the file to line 1', () => {
    const head = 'a\nb\nc\n'
    const current = 'b\nc\n'
    expect(computeDirtyDiffRegions(head, current)).toEqual([
      { startLine: 1, endLine: 1, originalStartLine: 1, originalEndLine: 1, kind: 'deleted' },
    ])
  })

  it('treats a brand-new file (empty HEAD) as one added region', () => {
    const current = 'a\nb\nc\n'
    expect(computeDirtyDiffRegions('', current)).toEqual([
      { startLine: 1, endLine: 3, originalStartLine: 0, originalEndLine: -1, kind: 'added' },
    ])
  })

  it('handles multiple independent hunks', () => {
    const head = 'a\nb\nc\nd\ne\n'
    const current = 'a\nX\nc\nd\ne\nf\n'
    expect(computeDirtyDiffRegions(head, current)).toEqual([
      { startLine: 2, endLine: 2, originalStartLine: 2, originalEndLine: 2, kind: 'modified' },
      { startLine: 6, endLine: 6, originalStartLine: 5, originalEndLine: 4, kind: 'added' },
    ])
  })

  it('tracks original line range for a multi-line replacement', () => {
    const head = 'a\nb\nc\nd\n'
    const current = 'a\nX\nY\nZ\nd\n'
    expect(computeDirtyDiffRegions(head, current)).toEqual([
      { startLine: 2, endLine: 4, originalStartLine: 2, originalEndLine: 3, kind: 'modified' },
    ])
  })

  it('ignores CRLF vs LF differences', () => {
    const head = 'a\r\nb\r\nc\r\n'
    const current = 'a\nb\nc\n'
    expect(computeDirtyDiffRegions(head, current)).toEqual([])
  })
})

/**
 * The hot path (DirtyDiffContribution) feeds pre-split lines: a cached
 * toDiffLines(HEAD) against Monaco's getLinesContent() run through
 * trimTrailingEmptyLine. Both entry points must agree, and the trailing-newline
 * phantom line Monaco reports must never show up as a change.
 */
describe('computeDirtyDiffRegionsFromLines', () => {
  it('matches the string entry point for a mixed edit', () => {
    const head = 'a\r\nb\r\nc\r\nd\r\n'
    const current = 'a\nX\nc\nd\ne\n'
    expect(computeDirtyDiffRegionsFromLines(toDiffLines(head), toDiffLines(current))).toEqual(
      computeDirtyDiffRegions(head, current),
    )
  })

  it('reports no change between a trailing-newline HEAD and Monaco-style lines', () => {
    // Monaco's getLinesContent() for "a\nb\n" is ['a','b',''] — the phantom
    // final line must be trimmed so it never diffs against HEAD's ['a','b'].
    const headLines = toDiffLines('a\nb\n')
    const monacoLines = trimTrailingEmptyLine(['a', 'b', ''])
    expect(computeDirtyDiffRegionsFromLines(headLines, monacoLines)).toEqual([])
  })
})

describe('toDiffLines', () => {
  it('normalizes CRLF and drops the phantom trailing line', () => {
    expect(toDiffLines('a\r\nb\r\n')).toEqual(['a', 'b'])
    expect(toDiffLines('a\nb')).toEqual(['a', 'b'])
    expect(toDiffLines('')).toEqual([])
  })

  it('keeps interior empty lines', () => {
    expect(toDiffLines('a\n\nb\n')).toEqual(['a', '', 'b'])
  })
})

describe('trimTrailingEmptyLine', () => {
  it('drops exactly one trailing empty element', () => {
    expect(trimTrailingEmptyLine(['a', 'b', ''])).toEqual(['a', 'b'])
    expect(trimTrailingEmptyLine(['a', '', ''])).toEqual(['a', ''])
    expect(trimTrailingEmptyLine([''])).toEqual([])
    expect(trimTrailingEmptyLine([])).toEqual([])
  })
})
