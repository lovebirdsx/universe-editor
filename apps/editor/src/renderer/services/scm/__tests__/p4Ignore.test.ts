/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Tests for the built-in Perforce ignore engine — the parser and the evaluator
 *  are pure, so everything here is table-shaped: a rule file's text, a candidate
 *  path relative to it, an expected verdict.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  evaluateP4Ignore,
  parseP4IgnoreFile,
  parseP4IgnoreSetting,
  splitP4IgnoreSpec,
  type P4IgnoreLevel,
} from '../p4Ignore.js'

const ROOT = 'X:/p4ws/main'

/** One rule file at {@link ROOT} governing `relPath`. */
function level(content: string, relPath: string, dir = ROOT): P4IgnoreLevel {
  return { dir, relPath, patterns: parseP4IgnoreFile(content) }
}

function ignored(content: string, relPath: string, isDirectory = false): boolean {
  return evaluateP4Ignore([level(content, relPath)], isDirectory).ignored
}

describe('parseP4IgnoreFile', () => {
  it('skips blank lines and indented comments', () => {
    expect(ignored('\n   \n# a comment\n\n', 'x.txt')).toBe(false)
  })

  it('treats an escaped hash and bang as literals, not as comment or negation', () => {
    // `\#note` is a file literally named `#note`; the `#` must not start a
    // comment. `\!keep` is a file named `!keep`; the `!` must not re-include.
    expect(ignored('\\#note', '#note')).toBe(true)
    expect(ignored('\\!keep', '!keep')).toBe(true)
  })

  it('strips a trailing separator and marks the rule directory-only', () => {
    const [pattern] = parseP4IgnoreFile('build/\n')
    expect(pattern?.directoryOnly).toBe(true)
    expect(pattern?.source).toBe('build/')
    const [backslash] = parseP4IgnoreFile('build\\\n')
    expect(backslash?.directoryOnly).toBe(true)
  })

  it('treats only a LEADING slash as an anchor', () => {
    const [anchored] = parseP4IgnoreFile('/build\n')
    expect(anchored?.matches('build')).toBe(true)
    expect(anchored?.matches('sub/build')).toBe(false)
    // Unlike gitignore, an inner slash does NOT anchor: `sub/build` still
    // matches at any depth.
    const [inner] = parseP4IgnoreFile('sub/build\n')
    expect(inner?.matches('sub/build')).toBe(true)
    expect(inner?.matches('deep/sub/build')).toBe(true)
  })

  it('normalizes backslash separators', () => {
    const [pattern] = parseP4IgnoreFile('build\\win32\\\n')
    expect(pattern?.matches('build/win32')).toBe(true)
  })

  it('tolerates CRLF line endings', () => {
    // The `\r` must not ride along on the pattern: a trailing `\r` would hide
    // the directory marker and leave `out.obj\r` matching nothing.
    expect(ignored('build/\r\nout.obj\r\n', 'build/x.obj')).toBe(true)
    expect(ignored('build/\r\nout.obj\r\n', 'deep/out.obj')).toBe(true)
  })

  it('keeps `*` inside a segment and lets `**` cross separators', () => {
    expect(ignored('*.obj', 'a/b/x.obj')).toBe(true)
    expect(ignored('build/*.obj', 'build/x.obj')).toBe(true)
    expect(ignored('build/*.obj', 'build/nested/x.obj')).toBe(false)
    expect(ignored('build/**', 'build/nested/x.obj')).toBe(true)
  })
})

describe('evaluateP4Ignore', () => {
  it('matches a bare name at any depth, including the top level', () => {
    expect(ignored('out.obj', 'out.obj')).toBe(true)
    expect(ignored('out.obj', 'a/b/out.obj')).toBe(true)
  })

  it('keeps an anchored rule inside the rule file directory', () => {
    expect(ignored('/build/', 'build/x.obj')).toBe(true)
    expect(ignored('/build/', 'src/build/x.obj')).toBe(false)
  })

  it('carries a directory rule down to everything under it', () => {
    expect(ignored('build/', 'build/generated/deep/x.obj')).toBe(true)
    expect(ignored('build', 'build/generated/x.obj')).toBe(true)
  })

  it('does not let a directory-only rule match a file of the same name', () => {
    expect(ignored('build/', 'build', true)).toBe(true)
    // The same-named FILE survives: a trailing slash is what makes a rule
    // directory-only, and `build/` says nothing about a regular file `build`.
    expect(ignored('build/', 'build', false)).toBe(false)
  })

  it('lets a later line override an earlier one in the same file', () => {
    expect(ignored('build/\n!build/keep/\n', 'build/keep/x.ts')).toBe(false)
    expect(ignored('build/\n!build/keep/\n', 'build/other/x.ts')).toBe(true)
  })

  it('lets a negated rule re-include under an excluded tree', () => {
    // Deliberate divergence from gitignore, and the shape Unreal's own rule
    // files rely on: a build artifact under the re-included subtree survives,
    // its sibling elsewhere does not.
    const rules = '**/DerivedDataCache/\n!**/Source/**/DerivedDataCache/\n'
    expect(ignored(rules, 'Source/App/DerivedDataCache/x.bin')).toBe(false)
    expect(ignored(rules, 'Binaries/DerivedDataCache/x.bin')).toBe(true)
  })

  it('reports the deciding rule and its directory', () => {
    const deep = level('!keep.ts\n', 'keep.ts', 'X:/p4ws/main/sub')
    const verdict = evaluateP4Ignore([level('*.ts\n', 'keep.ts', ROOT), deep], false)
    expect(verdict.ignored).toBe(false)
    expect(verdict.by).toEqual({
      dir: 'X:/p4ws/main/sub',
      source: '!keep.ts',
      negated: true,
    })
  })

  it('returns not-ignored for an empty or unrelated rule set', () => {
    expect(evaluateP4Ignore([], false).ignored).toBe(false)
    expect(ignored('# nothing here\n', 'x.ts')).toBe(false)
  })

  it('is not ignored just because a rule file lives above the candidate', () => {
    expect(ignored('*.obj', 'src/a.ts')).toBe(false)
  })
})

describe('parseP4IgnoreSetting', () => {
  it('reads P4IGNORE case-insensitively and ignores comments', () => {
    expect(parseP4IgnoreSetting('# c\nP4PORT=x:1666\np4ignore = myignore.txt\n')).toBe(
      'myignore.txt',
    )
  })

  it('returns null when the file declares no P4IGNORE', () => {
    expect(parseP4IgnoreSetting('P4CLIENT=ws\n')).toBeNull()
    expect(parseP4IgnoreSetting('')).toBeNull()
  })
})

describe('splitP4IgnoreSpec', () => {
  it('separates bare names from entries carrying a separator', () => {
    expect(splitP4IgnoreSpec('a.txt; sub/b.txt ;;c.txt')).toEqual({
      names: ['a.txt', 'c.txt'],
      paths: ['sub/b.txt'],
    })
  })
})
