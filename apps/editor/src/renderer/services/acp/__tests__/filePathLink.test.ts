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
  splitFilePathTarget,
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

  it('strips an @ marker from explicit file mentions', () => {
    expect(matchFilePathAt('@src/a.ts', 0)).toEqual({
      full: '@src/a.ts',
      path: 'src/a.ts',
      line: undefined,
      col: undefined,
    })
    expect(matchFilePathAt('@path/to/file', 0)?.path).toBe('path/to/file')
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

  it('does NOT cross an inline-code boundary (backtick)', () => {
    // Regression: a bare path must stop at a backtick, not swallow adjacent code
    // spans / prose. `（` opens a full-width paren; the old grammar matched from
    // there straight through `ExplorerView.tsx`, eating two backtick-fenced spans.
    expect(matchFilePathAt('`workbench-ui/src/tree/`', 0)).toBeNull()
    const inner = matchFilePathAt('workbench-ui/src/tree/Tree.tsx`', 0)
    expect(inner?.path).toBe('workbench-ui/src/tree/Tree.tsx')
  })

  it('does NOT swallow CJK text or full-width punctuation', () => {
    // Regression (problem 1/2): paths must not extend into Chinese prose or
    // full-width brackets/middle-dots/dashes around them.
    expect(matchFilePathAt('（`workbench-ui/src/tree/`）内置虚拟化', 0)).toBeNull()
    expect(matchFilePathAt('02·P0/P1）——acpSession.ts', 0)).toBeNull()
    // A clean path immediately followed by CJK stops at the boundary.
    expect(matchFilePathAt('src/a.ts内置', 0)?.path).toBe('src/a.ts')
  })

  it('does not catastrophically backtrack on a slash-dense data: URL (freeze repro)', () => {
    // Regression: restoring a session with an image lands the image as a
    // `[@image](data:image/png;base64,<~8KB>)` markdown text block. The inline
    // parser probes matchFilePathAt at every position; the base64 body is dense
    // with '/' and '+' and ends without a valid extension. When the path
    // segment class could itself contain '/', the `(?:SEG+/)*SEG+` groups
    // degenerated into `(a+)+` and backtracked exponentially — a single 8KB URL
    // froze the renderer for tens of seconds. This must stay linear.
    const base64 = Array.from({ length: 4000 }, (_, i) => 'ab/cd+ef'[i % 8]).join('')
    const url = `data:image/png;base64,${base64}`
    const start = Date.now()
    for (let i = 0; i < url.length; i++) matchFilePathAt(url, i)
    // Comfortably linear; the buggy version never returned within the vitest
    // timeout. A generous ceiling avoids CI-machine flakiness.
    expect(Date.now() - start).toBeLessThan(1000)
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

  it('accepts cross-file markdown fragments and @ file mentions', () => {
    expect(looksLikeFilePath('./foo.md#hello')).toBe(true)
    expect(looksLikeFilePath('@src/a.ts')).toBe(true)
    expect(looksLikeFilePath('@path/to/file')).toBe(true)
    expect(looksLikeFilePath('@./foo.md#hello')).toBe(true)
  })

  it('accepts absolute paths without an extension (directory targets)', () => {
    // Drive-absolute and POSIX-absolute paths are filesystem paths even without a
    // known extension — they may point at a directory (`[vscode](D:/…/vscode)`).
    expect(looksLikeFilePath('D:/git_project/vscode')).toBe(true)
    expect(looksLikeFilePath('D:\\git_project\\vscode')).toBe(true)
    expect(looksLikeFilePath('C:/Users/foo')).toBe(true)
    expect(looksLikeFilePath('/usr/local/lib')).toBe(true)
  })

  it('accepts drive-absolute file paths despite the `D:` looking like a scheme', () => {
    expect(looksLikeFilePath('D:/a/b.md')).toBe(true)
    expect(looksLikeFilePath('C:\\a\\b.ts')).toBe(true)
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

describe('splitFilePathTarget', () => {
  it('strips @ and separates a cross-file fragment', () => {
    expect(splitFilePathTarget('@./foo.md#hello')).toEqual({
      path: './foo.md',
      fragment: 'hello',
    })
  })

  it('keeps a line location before the fragment', () => {
    expect(splitFilePathTarget('@src/a.ts:10:5#hello')).toEqual({
      path: 'src/a.ts',
      line: 10,
      col: 5,
      fragment: 'hello',
    })
  })
})
