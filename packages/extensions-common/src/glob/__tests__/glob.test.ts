import { describe, expect, it } from 'vitest'
import { compileGlobMatcher, normalizeExtensionGlobPattern, splitAbsoluteGlob } from '../glob.js'

// The engine itself (and its full test battery, incl. the cross-entry matrix
// against the platform settings entry) lives in
// packages/platform/src/__tests__/glob/glob.test.ts — these cases assert the
// re-export here keeps the extension-surface semantics intact.
describe('compileGlobMatcher (re-exported from platform)', () => {
  it('a slashless pattern matches the basename at any depth', () => {
    const m = compileGlobMatcher('*.ts')
    expect(m('a.ts')).toBe(true)
    expect(m('src/deep/a.ts')).toBe(true)
    expect(m('a.tsx')).toBe(false)
  })

  it('`**`, `?`, `{a,b}` and `[...]` all compile as glob', () => {
    expect(compileGlobMatcher('**/test/**/a.css')('x/test/y/a.css')).toBe(true)
    expect(compileGlobMatcher('foo?.js')('foo1.js')).toBe(true)
    expect(compileGlobMatcher('**/*.{ts,tsx}')('src/a.tsx')).toBe(true)
    expect(compileGlobMatcher('[!a-z].ts')('M.ts')).toBe(true)
    expect(compileGlobMatcher('[!a-z].ts')('m.ts')).toBe(false)
  })

  it('normalizes Windows backslashes in both pattern and input', () => {
    const m = compileGlobMatcher('src\\**\\*.ts')
    expect(m('src\\deep\\a.ts')).toBe(true)
    expect(m('src/deep/a.ts')).toBe(true)
  })

  it('matching is case-sensitive', () => {
    expect(compileGlobMatcher('*.ts')('A.TS')).toBe(false)
  })
})

describe('normalizeExtensionGlobPattern (re-exported from platform)', () => {
  it('prefixes a slashless pattern with `**/`', () => {
    expect(normalizeExtensionGlobPattern('*.ts')).toBe('**/*.ts')
  })

  it('passes anchored patterns, `**` and empty patterns through', () => {
    expect(normalizeExtensionGlobPattern('src/*.ts')).toBe('src/*.ts')
    expect(normalizeExtensionGlobPattern('**')).toBe('**')
    expect(normalizeExtensionGlobPattern('')).toBe('')
  })
})

describe('splitAbsoluteGlob', () => {
  it('rejects workspace-relative patterns', () => {
    expect(splitAbsoluteGlob('**/*.ts')).toBeNull()
    expect(splitAbsoluteGlob('src/*.ts')).toBeNull()
    expect(splitAbsoluteGlob('*.ts')).toBeNull()
    expect(splitAbsoluteGlob('./src/a.ts')).toBeNull()
    expect(splitAbsoluteGlob('../sibling/a.ts')).toBeNull()
  })

  it('splits at the first glob-bearing path segment', () => {
    expect(splitAbsoluteGlob('/abs/logs/**/*.log')).toEqual({
      base: '/abs/logs',
      pattern: '**/*.log',
    })
    expect(splitAbsoluteGlob('D:\\logs\\**\\*.log')).toEqual({
      base: 'D:/logs',
      pattern: '**/*.log',
    })
    expect(splitAbsoluteGlob('/abs/v[0-9]/a.ts')).toEqual({
      base: '/abs',
      pattern: 'v[0-9]/a.ts',
    })
  })

  it('a glob-free absolute path targets a single entry', () => {
    expect(splitAbsoluteGlob('/abs/config.json')).toEqual({
      base: '/abs',
      pattern: 'config.json',
    })
  })

  it('rejects a pattern with no literal segment above the glob', () => {
    expect(splitAbsoluteGlob('/*.ts')).toBeNull()
    expect(splitAbsoluteGlob('D:/**/*.ts')).toBeNull()
  })

  it('a bare filesystem root cannot anchor a watch', () => {
    expect(splitAbsoluteGlob('/config.json')).toBeNull()
    expect(splitAbsoluteGlob('D:/config.json')).toBeNull()
    expect(splitAbsoluteGlob('/abs/logs/')).toBeNull()
    expect(splitAbsoluteGlob('/')).toBeNull()
  })

  it('the split pieces still match through compileGlobMatcher', () => {
    const split = splitAbsoluteGlob('/abs/logs/**/*.log')
    expect(split).not.toBeNull()
    const matches = compileGlobMatcher(split!.pattern)
    expect(matches('app/server.log')).toBe(true)
    expect(matches('app/server.txt')).toBe(false)
  })
})
