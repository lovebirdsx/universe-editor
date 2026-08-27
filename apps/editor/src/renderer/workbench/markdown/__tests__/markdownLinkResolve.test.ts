/*---------------------------------------------------------------------------------------------
 *  Tests for markdownLinkResolve — candidate ordering and search-pattern rules
 *  for opening a file path clicked inside rendered markdown.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { URI } from '@universe-editor/platform'
import {
  fileUriLinkTarget,
  isAbsolutePath,
  markdownLinkCandidates,
  searchPatternFor,
} from '../markdownLinkResolve.js'

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

  it('decodes percent-encoded absolute paths before probing', () => {
    const encoded =
      'C:/Users/testuser/AppData/Local/Programs/Universe%20Editor/resources/docs/user/zh-CN/customization/ai-providers.md'
    const c = markdownLinkCandidates(encoded, baseDir, root)

    expect(c[0]!.fsPath).toContain('Universe Editor')
    expect(c[0]!.fsPath).not.toContain('%20')
    expect(c[1]!.fsPath).toContain('Universe%20Editor')
  })

  it('decodes percent-encoded relative paths before resolving candidates', () => {
    const c = markdownLinkCandidates('docs/Universe%20Editor/ai-providers.md', baseDir, root)

    expect(c.map((u) => u.path)).toEqual([
      '/repo/docs/plan/docs/Universe Editor/ai-providers.md',
      '/repo/docs/Universe Editor/ai-providers.md',
      '/repo/docs/plan/docs/Universe%20Editor/ai-providers.md',
      '/repo/docs/Universe%20Editor/ai-providers.md',
    ])
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

  it('expands a leading ~ to home when homeDir is provided', () => {
    const c = markdownLinkCandidates('~/.claude/plans/x.md', baseDir, root, 'C:/Users/u')
    expect(c.map((u) => u.fsPath)).toEqual(['C:/Users/u/.claude/plans/x.md'])
  })

  it('keeps ~ as a relative path when homeDir is not provided', () => {
    const c = markdownLinkCandidates('~/.claude/plans/x.md', baseDir, root)
    expect(c.map((u) => u.path)).toEqual([
      '/repo/docs/plan/~/.claude/plans/x.md',
      '/repo/~/.claude/plans/x.md',
    ])
  })

  it('expands ~ before decoding percent-encoded segments', () => {
    const c = markdownLinkCandidates('~/Universe%20Editor/x.md', baseDir, root, 'C:/Users/u')
    expect(c.map((u) => u.fsPath)).toEqual([
      'C:/Users/u/Universe Editor/x.md',
      'C:/Users/u/Universe%20Editor/x.md',
    ])
  })

  describe('remote workspace absolute paths', () => {
    const remoteRoot = URI.from({
      scheme: 'remote-ssh',
      authority: 'wsl+Ubuntu',
      path: '/home/dev/proj',
    })

    it('probes the remote workspace authority before the local file fallback', () => {
      const c = markdownLinkCandidates('/home/dev/proj/src/a.ts', remoteRoot, remoteRoot)
      expect(c[0]?.toString()).toBe('remote-ssh://wsl+Ubuntu/home/dev/proj/src/a.ts')
      expect(c[1]?.scheme).toBe('file')
      expect(c).toHaveLength(2)
    })

    it('inherits the remote authority from the workspace root when the base dir is local', () => {
      const c = markdownLinkCandidates('/home/dev/proj/src/a.ts', baseDir, remoteRoot)
      expect(c[0]?.toString()).toBe('remote-ssh://wsl+Ubuntu/home/dev/proj/src/a.ts')
      expect(c[1]?.scheme).toBe('file')
    })

    it('inherits the remote authority from the workspace root when the base dir is missing', () => {
      const c = markdownLinkCandidates('/home/dev/proj/src/a.ts', undefined, remoteRoot)
      expect(c[0]?.toString()).toBe('remote-ssh://wsl+Ubuntu/home/dev/proj/src/a.ts')
      expect(c[1]?.scheme).toBe('file')
    })

    it('keeps a single file candidate for a local workspace absolute path', () => {
      const c = markdownLinkCandidates('/etc/hosts', baseDir, root)
      expect(c.map((u) => u.toString())).toEqual(['file:///etc/hosts'])
    })

    it('attaches the remote authority to a windows drive path before the file fallback', () => {
      const c = markdownLinkCandidates('C:\\x\\a.ts', remoteRoot, remoteRoot)
      expect(c[0]?.toString()).toBe('remote-ssh://wsl+Ubuntu/C:/x/a.ts')
      expect(c[1]?.scheme).toBe('file')
      expect(c).toHaveLength(2)
    })

    it('probes the remote authority for decoded percent-encoded variants first', () => {
      const c = markdownLinkCandidates('/home/dev/Universe%20Editor/a.ts', remoteRoot, remoteRoot)
      expect(c[0]?.scheme).toBe('remote-ssh')
      expect(c[0]?.authority).toBe('wsl+Ubuntu')
      expect(c[0]?.path).toBe('/home/dev/Universe Editor/a.ts')
      expect(c[2]?.scheme).toBe('remote-ssh')
      expect(c[2]?.path).toBe('/home/dev/Universe%20Editor/a.ts')
    })
  })
})

describe('searchPatternFor', () => {
  it('strips ./ and ../ segments and normalizes separators', () => {
    expect(searchPatternFor('../../src/a.ts')).toBe('src/a.ts')
    expect(searchPatternFor('a\\b\\c.ts')).toBe('a/b/c.ts')
    expect(searchPatternFor('./x.ts')).toBe('x.ts')
  })

  it('decodes percent-encoded path segments', () => {
    expect(searchPatternFor('docs/Universe%20Editor/ai-providers.md')).toBe(
      'docs/Universe Editor/ai-providers.md',
    )
  })

  it('is empty for a path of only relative segments', () => {
    expect(searchPatternFor('../..')).toBe('')
  })
})

describe('fileUriLinkTarget', () => {
  it('extracts the path from a file: URI link', () => {
    expect(fileUriLinkTarget('file:///D:/workspace/vscode')).toEqual({
      path: 'D:/workspace/vscode',
    })
  })

  it('decodes percent-encoded path segments', () => {
    expect(fileUriLinkTarget('file:///D:/workspace/Universe%20Editor')).toEqual({
      path: 'D:/workspace/Universe Editor',
    })
  })

  it('splits a :line:col location off the URI path', () => {
    expect(fileUriLinkTarget('file:///D:/repo/src/a.ts:12:5')).toEqual({
      path: 'D:/repo/src/a.ts',
      line: 12,
      col: 5,
    })
  })

  it('splits a :line-endLine range off the URI path', () => {
    expect(fileUriLinkTarget('file:///D:/repo/src/a.ts:9-17')).toEqual({
      path: 'D:/repo/src/a.ts',
      line: 9,
      endLine: 17,
    })
  })

  it('splits the fragment off a file: URI link', () => {
    expect(fileUriLinkTarget('file:///D:/repo/docs/foo.md#hello')).toEqual({
      path: 'D:/repo/docs/foo.md',
      fragment: 'hello',
    })
  })

  it('extracts a POSIX file: URI path', () => {
    expect(fileUriLinkTarget('file:///etc/hosts')).toEqual({ path: '/etc/hosts' })
  })

  it('rejects a malformed file: URI', () => {
    expect(fileUriLinkTarget('file://')).toBeUndefined()
  })
})
