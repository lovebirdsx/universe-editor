/*---------------------------------------------------------------------------------------------
 *  Tests for filePathLink — bare file-path detection in rendered markdown. Covers
 *  absolute / relative paths, the directory-separator anti-false-positive rule,
 *  location suffixes, and explicit-href classification.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  looksLikeFilePath,
  matchFilePathAt,
  matchFullFilePath,
  splitFilePathLocation,
} from '../filePathLink.js'

describe('matchFilePathAt', () => {
  it('matches a relative path with a dir component', () => {
    expect(matchFilePathAt('src/foo/bar.ts', 0)).toEqual({
      full: 'src/foo/bar.ts',
      path: 'src/foo/bar.ts',
      line: undefined,
      col: undefined,
    })
  })

  it('matches a Windows absolute path', () => {
    const m = matchFilePathAt('C:\\repo\\a.ts', 0)
    expect(m?.path).toBe('C:\\repo\\a.ts')
  })

  it('matches a Unix absolute path', () => {
    expect(matchFilePathAt('/etc/app/config.yaml', 0)?.path).toBe('/etc/app/config.yaml')
  })

  it('matches ./ and ../ prefixes', () => {
    expect(matchFilePathAt('./a/b.ts', 0)?.path).toBe('./a/b.ts')
    expect(matchFilePathAt('../a/b.ts', 0)?.path).toBe('../a/b.ts')
  })

  it('captures :line:col location', () => {
    expect(matchFilePathAt('src/a.ts:10:5', 0)).toEqual({
      full: 'src/a.ts:10:5',
      path: 'src/a.ts',
      line: 10,
      col: 5,
    })
  })

  it('captures (line,col) location', () => {
    const m = matchFilePathAt('src/a.ts(10,5)', 0)
    expect(m).toEqual({ full: 'src/a.ts(10,5)', path: 'src/a.ts', line: 10, col: 5 })
  })

  it('does NOT match a bare filename without a dir separator', () => {
    expect(matchFilePathAt('package.json', 0)).toBeNull()
    expect(matchFilePathAt('index.ts', 0)).toBeNull()
  })

  it('does NOT match an unknown extension', () => {
    expect(matchFilePathAt('src/a.exe', 0)).toBeNull()
  })

  it('matches the full multi-char extension, not a shorter prefix', () => {
    // Regression: `.jsonl` must not truncate to `.js`, `.css` not to `.cs`.
    expect(matchFilePathAt('logs/data.jsonl', 0)?.path).toBe('logs/data.jsonl')
    expect(matchFilePathAt('ui/theme.css', 0)?.path).toBe('ui/theme.css')
    expect(matchFilePathAt('src/Tree.tsx', 0)?.path).toBe('src/Tree.tsx')
    expect(matchFilePathAt('a/b.scss', 0)?.path).toBe('a/b.scss')
    expect(matchFilePathAt('cfg/app.yaml', 0)?.path).toBe('cfg/app.yaml')
  })

  it('does NOT match a known extension that is only a prefix of the real one', () => {
    // `.jsonx` is not a known ext; `js`/`json` prefixes must not partial-match.
    expect(matchFilePathAt('src/a.jsonx', 0)).toBeNull()
  })

  it('does NOT match mid-token', () => {
    // The path starts at index 1 ("src/..."), but index 0 ("x") precedes it.
    expect(matchFilePathAt('xsrc/a.ts', 1)).toBeNull()
  })
})

describe('matchFullFilePath', () => {
  it('matches when the whole string is a path (backtick-wrapped case)', () => {
    expect(matchFullFilePath('packages/workbench-ui/src/tree/Tree.tsx')?.path).toBe(
      'packages/workbench-ui/src/tree/Tree.tsx',
    )
    expect(matchFullFilePath('src/a.ts:10')?.line).toBe(10)
  })

  it('returns null when there is surrounding text', () => {
    expect(matchFullFilePath('see src/a.ts here')).toBeNull()
  })

  it('returns null for a bare filename (no dir separator)', () => {
    expect(matchFullFilePath('package.json')).toBeNull()
  })
})

describe('looksLikeFilePath', () => {
  it('accepts relative and bare-filename hrefs', () => {
    expect(looksLikeFilePath('../foo.md')).toBe(true)
    expect(looksLikeFilePath('src/a.ts')).toBe(true)
    expect(looksLikeFilePath('index.ts')).toBe(true)
  })

  it('rejects URL schemes', () => {
    expect(looksLikeFilePath('https://example.com')).toBe(false)
    expect(looksLikeFilePath('file:///a.ts')).toBe(false)
    expect(looksLikeFilePath('mailto:x@y.com')).toBe(false)
  })

  it('rejects non-path text', () => {
    expect(looksLikeFilePath('just some words')).toBe(false)
  })
})

describe('splitFilePathLocation', () => {
  it('splits :line:col', () => {
    expect(splitFilePathLocation('src/a.ts:10:5')).toEqual({ path: 'src/a.ts', line: 10, col: 5 })
  })

  it('returns the path unchanged when no location', () => {
    expect(splitFilePathLocation('../foo.md')).toEqual({
      path: '../foo.md',
      line: undefined,
      col: undefined,
    })
  })
})
