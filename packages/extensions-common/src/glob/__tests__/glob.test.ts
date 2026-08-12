import { describe, expect, it } from 'vitest'
import { compileGlobMatcher } from '../glob.js'

describe('compileGlobMatcher', () => {
  it('matches a literal relative path exactly', () => {
    const m = compileGlobMatcher('src/index.ts')
    expect(m('src/index.ts')).toBe(true)
    expect(m('src/other.ts')).toBe(false)
    expect(m('lib/src/index.ts')).toBe(false)
  })

  it('`*` stays within one path segment', () => {
    const m = compileGlobMatcher('src/*.ts')
    expect(m('src/a.ts')).toBe(true)
    expect(m('src/deep/a.ts')).toBe(false)
  })

  it('a slashless pattern matches the basename at any depth', () => {
    const m = compileGlobMatcher('*.ts')
    expect(m('a.ts')).toBe(true)
    expect(m('src/deep/a.ts')).toBe(true)
    expect(m('a.tsx')).toBe(false)
  })

  it('`**` crosses directory levels', () => {
    const m = compileGlobMatcher('**/test/**/a.css')
    expect(m('test/a.css')).toBe(true) // both `**/` optionals match zero segments
    expect(m('test/x/a.css')).toBe(true)
    expect(m('a/b/test/x/y/a.css')).toBe(true)
    expect(m('a/b/test/x/y/a.css2')).toBe(false)
  })

  it('`src/**` matches everything below src', () => {
    const m = compileGlobMatcher('src/**')
    expect(m('src/a/b/c.ts')).toBe(true)
    expect(m('lib/a.ts')).toBe(false)
  })

  it('`**/*.ts` also matches at the root (zero segments)', () => {
    const m = compileGlobMatcher('**/*.ts')
    expect(m('a.ts')).toBe(true)
    expect(m('src/a.ts')).toBe(true)
  })

  it('`?` matches exactly one non-separator character', () => {
    const m = compileGlobMatcher('foo?.js')
    expect(m('foo1.js')).toBe(true)
    expect(m('foo12.js')).toBe(false)
    expect(m('foo/1.js')).toBe(false)
  })

  it('`{a,b}` alternates', () => {
    const m = compileGlobMatcher('**/*.{ts,tsx}')
    expect(m('a.ts')).toBe(true)
    expect(m('src/b.tsx')).toBe(true)
    expect(m('c.css')).toBe(false)
  })

  it('brace alternatives compile as glob fragments', () => {
    const m = compileGlobMatcher('{src/*,test}/a.ts')
    expect(m('src/x/a.ts')).toBe(true)
    expect(m('test/a.ts')).toBe(true)
    expect(m('src/x/y/a.ts')).toBe(false)
  })

  it('`[...]` character classes with ranges and negation', () => {
    expect(compileGlobMatcher('[a-z].ts')('m.ts')).toBe(true)
    expect(compileGlobMatcher('[a-z].ts')('M.ts')).toBe(false)
    expect(compileGlobMatcher('[!a-z].ts')('M.ts')).toBe(true)
    expect(compileGlobMatcher('[^a-z].ts')('M.ts')).toBe(true)
    expect(compileGlobMatcher('[!a-z].ts')('m.ts')).toBe(false)
  })

  it('normalizes Windows backslashes in both pattern and input', () => {
    const m = compileGlobMatcher('src\\**\\*.ts')
    expect(m('src\\deep\\a.ts')).toBe(true)
    expect(m('src/deep/a.ts')).toBe(true)
  })

  it('strips leading slashes on the matched value', () => {
    expect(compileGlobMatcher('src/a.ts')('/src/a.ts')).toBe(true)
  })

  it('escapes regex metacharacters in literals', () => {
    const m = compileGlobMatcher('a+b(c).ts')
    expect(m('a+b(c).ts')).toBe(true)
    expect(m('a+bc.ts')).toBe(false)
  })

  it('an unclosed `{` or `[` is a literal character', () => {
    expect(compileGlobMatcher('a{b.ts')('a{b.ts')).toBe(true)
    expect(compileGlobMatcher('a[b.ts')('a[b.ts')).toBe(true)
  })

  it('matching is case-sensitive', () => {
    expect(compileGlobMatcher('*.ts')('A.TS')).toBe(false)
  })
})
