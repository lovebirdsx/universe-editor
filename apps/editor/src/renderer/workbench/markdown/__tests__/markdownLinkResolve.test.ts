/*---------------------------------------------------------------------------------------------
 *  Tests for markdownLinkResolve — candidate ordering and search-pattern rules
 *  for opening a file path clicked inside rendered markdown.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { URI } from '@universe-editor/platform'
import { isAbsolutePath, markdownLinkCandidates, searchPatternFor } from '../markdownLinkResolve.js'

const root = URI.file('/repo')
const baseDir = URI.file('/repo/docs/plan')

describe('isAbsolutePath', () => {
  it('detects posix and windows absolute paths', () => {
    expect(isAbsolutePath('/etc/hosts')).toBe(true)
    expect(isAbsolutePath('C:/a/b.ts')).toBe(true)
    expect(isAbsolutePath('C:\\a\\b.ts')).toBe(true)
    expect(isAbsolutePath('src/a.ts')).toBe(false)
    expect(isAbsolutePath('./a.ts')).toBe(false)
  })
})

describe('markdownLinkCandidates', () => {
  it('returns a single candidate for an absolute path', () => {
    const c = markdownLinkCandidates('/etc/hosts', baseDir, root)
    expect(c.map((u) => u.path)).toEqual(['/etc/hosts'])
  })

  it('probes the source dir before the workspace root for a relative path', () => {
    const c = markdownLinkCandidates('foo.md', baseDir, root)
    expect(c.map((u) => u.path)).toEqual(['/repo/docs/plan/foo.md', '/repo/foo.md'])
  })

  it('resolves a workspace-relative path (problem 3: scripts/gen-editor-schema.mjs)', () => {
    const c = markdownLinkCandidates('scripts/gen-editor-schema.mjs', baseDir, root)
    expect(c.map((u) => u.path)).toContain('/repo/scripts/gen-editor-schema.mjs')
  })

  it('honors ./ and ../ against the base dir', () => {
    const c = markdownLinkCandidates('../README.md', baseDir, root)
    expect(c[0]?.path).toBe('/repo/docs/README.md')
  })

  it('normalizes backslashes', () => {
    const c = markdownLinkCandidates('a\\b.ts', baseDir, root)
    expect(c[0]?.path).toBe('/repo/docs/plan/a/b.ts')
  })

  it('de-duplicates when base dir and root resolve to the same uri', () => {
    const c = markdownLinkCandidates('x.ts', root, root)
    expect(c.map((u) => u.path)).toEqual(['/repo/x.ts'])
  })

  it('skips a candidate when its anchor is missing', () => {
    expect(markdownLinkCandidates('a.ts', undefined, root).map((u) => u.path)).toEqual([
      '/repo/a.ts',
    ])
    expect(markdownLinkCandidates('a.ts', baseDir, undefined).map((u) => u.path)).toEqual([
      '/repo/docs/plan/a.ts',
    ])
    expect(markdownLinkCandidates('a.ts', undefined, undefined)).toEqual([])
  })
})

describe('searchPatternFor', () => {
  it('strips ./ and ../ segments and normalizes separators', () => {
    expect(searchPatternFor('../../src/a.ts')).toBe('src/a.ts')
    expect(searchPatternFor('a\\b\\c.ts')).toBe('a/b/c.ts')
    expect(searchPatternFor('./x.ts')).toBe('x.ts')
  })

  it('is empty for a path of only relative segments', () => {
    expect(searchPatternFor('../..')).toBe('')
  })
})
