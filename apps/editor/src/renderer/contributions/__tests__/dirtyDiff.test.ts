import { describe, expect, it } from 'vitest'
import {
  computeDirtyDiffRegions,
  computeDirtyDiffRegionsFromLines,
  computeScmHeadCacheInvalidation,
  toDiffLines,
  trimTrailingEmptyLine,
  type ScmFileDecorationState,
  type ScmHeadSnapshot,
  type ScmProviderHeadState,
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

describe('computeScmHeadCacheInvalidation', () => {
  const files = (entries: Record<string, string>): ReadonlyMap<string, ScmFileDecorationState> =>
    new Map(Object.entries(entries).map(([key, letter]) => [key, { letter }]))

  const heads = (
    entries: ReadonlyArray<[number, string, string | undefined]>,
  ): ReadonlyMap<number, ScmProviderHeadState> =>
    new Map(
      entries.map(([handle, providerId, headRevision]) => [handle, { providerId, headRevision }]),
    )

  const snap = (
    f: ReadonlyMap<string, ScmFileDecorationState>,
    h: ReadonlyMap<number, ScmProviderHeadState>,
  ): ScmHeadSnapshot => ({ files: f, heads: h })

  // Problem 1 regression: `undoLastCommit` (git reset --soft HEAD~1) moves HEAD
  // C2 → C1 while the active file F keeps its merged working letter M (it is now
  // staged M + working M) and G appears as staged. The old file-only heuristic
  // returned {paths: {G}} and left F stale; with the HEAD commit we must drop the
  // whole provider, which covers F.
  it('invalidates the whole provider when its HEAD commit moved (reset --soft case)', () => {
    const decision = computeScmHeadCacheInvalidation(
      snap(files({ F: 'M' }), heads([[1, 'git', 'C2']])),
      snap(files({ F: 'M', G: 'M' }), heads([[1, 'git', 'C1']])),
    )
    expect(decision).toEqual({ full: false, providerIds: new Set(['git']), paths: new Set() })
  })

  it('does not invalidate anything when HEAD is unchanged but a file letter changed', () => {
    const decision = computeScmHeadCacheInvalidation(
      snap(files({ F: 'M' }), heads([[1, 'git', 'C2']])),
      snap(files({ F: 'A' }), heads([[1, 'git', 'C2']])),
    )
    expect(decision).toEqual({ full: false, providerIds: new Set(), paths: new Set() })
  })

  it('does not invalidate anything on an unchanged HEAD and empty file diff', () => {
    const decision = computeScmHeadCacheInvalidation(
      snap(files({ F: 'M' }), heads([[1, 'git', 'C2']])),
      snap(files({ F: 'M' }), heads([[1, 'git', 'C2']])),
    )
    expect(decision).toEqual({ full: false, providerIds: new Set(), paths: new Set() })
  })

  it('treats a provider that starts reporting a HEAD as a move (undefined → hash)', () => {
    const decision = computeScmHeadCacheInvalidation(
      snap(files({}), heads([[1, 'git', undefined]])),
      snap(files({}), heads([[1, 'git', 'C1']])),
    )
    expect(decision).toEqual({ full: false, providerIds: new Set(['git']), paths: new Set() })
  })

  it('treats a provider that stops reporting a HEAD as a move (hash → undefined)', () => {
    const decision = computeScmHeadCacheInvalidation(
      snap(files({}), heads([[1, 'git', 'C1']])),
      snap(files({}), heads([[1, 'git', undefined]])),
    )
    expect(decision).toEqual({ full: false, providerIds: new Set(['git']), paths: new Set() })
  })

  it('invalidates only the provider whose HEAD moved, leaving the other provider cached', () => {
    const decision = computeScmHeadCacheInvalidation(
      snap(
        files({}),
        heads([
          [1, 'git', 'C2'],
          [2, 'perforce', 'x1'],
        ]),
      ),
      snap(
        files({}),
        heads([
          [1, 'git', 'C1'],
          [2, 'perforce', 'x1'],
        ]),
      ),
    )
    expect(decision).toEqual({ full: false, providerIds: new Set(['git']), paths: new Set() })
  })

  // Fallback: a provider that never reports a HEAD revision leaves nothing to
  // compare, so the old file-status heuristic applies (conservatively).
  it('falls back to the file heuristic when the provider reports no HEAD', () => {
    const p4 = heads([[1, 'perforce', undefined]])
    expect(computeScmHeadCacheInvalidation(snap(files({}), p4), snap(files({}), p4))).toEqual({
      full: true,
      providerIds: new Set(),
      paths: new Set(),
    })
    expect(
      computeScmHeadCacheInvalidation(snap(files({ a: 'M' }), p4), snap(files({ a: 'M' }), p4)),
    ).toEqual({ full: true, providerIds: new Set(), paths: new Set() })
  })

  it('falls back to full when a file disappears and the provider reports no HEAD', () => {
    const p4 = heads([[1, 'perforce', undefined]])
    expect(
      computeScmHeadCacheInvalidation(
        snap(files({ a: 'M', b: 'M' }), p4),
        snap(files({ b: 'M' }), p4),
      ),
    ).toEqual({ full: true, providerIds: new Set(), paths: new Set() })
  })

  it('falls back to paths for appeared/changed files when the provider reports no HEAD', () => {
    const p4 = heads([[1, 'perforce', undefined]])
    expect(
      computeScmHeadCacheInvalidation(
        snap(files({ b: 'M' }), p4),
        snap(files({ a: 'M', b: 'M' }), p4),
      ),
    ).toEqual({ full: false, providerIds: new Set(), paths: new Set(['a']) })
    expect(
      computeScmHeadCacheInvalidation(
        snap(files({ a: '?', b: 'M' }), p4),
        snap(files({ a: 'M', b: 'M' }), p4),
      ),
    ).toEqual({ full: false, providerIds: new Set(), paths: new Set(['a']) })
  })
})
