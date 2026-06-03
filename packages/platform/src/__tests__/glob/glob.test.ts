/*---------------------------------------------------------------------------------------------
 *  Tests for packages/platform/src/glob/glob.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { makeExcludeMatcher, makeGlobMatcher } from '../../glob/glob.js'

describe('makeGlobMatcher', () => {
  it('returns null for an empty pattern list', () => {
    expect(makeGlobMatcher([])).toBeNull()
  })

  it('matches a literal path', () => {
    const m = makeGlobMatcher(['src/index.ts'])!
    expect(m('src/index.ts')).toBe(true)
    expect(m('src/index.tsx')).toBe(false)
  })

  it('single-* does not cross path separators', () => {
    const m = makeGlobMatcher(['src/*.ts'])!
    expect(m('src/index.ts')).toBe(true)
    expect(m('src/sub/index.ts')).toBe(false)
  })

  it('double-** matches across path segments', () => {
    const m = makeGlobMatcher(['**/*.ts'])!
    expect(m('a.ts')).toBe(true)
    expect(m('src/index.ts')).toBe(true)
    expect(m('src/deep/nested/file.ts')).toBe(true)
    expect(m('readme.md')).toBe(false)
  })

  it('? matches a single non-separator character', () => {
    const m = makeGlobMatcher(['file.?s'])!
    expect(m('file.ts')).toBe(true)
    expect(m('file.js')).toBe(true)
    expect(m('file.tsx')).toBe(false)
  })

  it('multiple patterns OR together', () => {
    const m = makeGlobMatcher(['**/*.ts', '**/*.tsx'])!
    expect(m('a.ts')).toBe(true)
    expect(m('a.tsx')).toBe(true)
    expect(m('a.js')).toBe(false)
  })

  it('supports brace alternation', () => {
    const m = makeGlobMatcher(['**/*.{ts,tsx}'])!
    expect(m('a.ts')).toBe(true)
    expect(m('src/a.tsx')).toBe(true)
    expect(m('a.js')).toBe(false)
  })

  it('supports brace alternation on path segments', () => {
    const m = makeGlobMatcher(['{src,test}/**'])!
    expect(m('src/a.ts')).toBe(true)
    expect(m('test/deep/b.ts')).toBe(true)
    expect(m('lib/c.ts')).toBe(false)
  })

  it('treats an unclosed brace as a literal', () => {
    const m = makeGlobMatcher(['a{b'])!
    expect(m('a{b')).toBe(true)
    expect(m('ab')).toBe(false)
  })

  it('matches a bare directory segment', () => {
    const m = makeGlobMatcher(['**/node_modules'])!
    expect(m('node_modules')).toBe(true)
    expect(m('packages/x/node_modules')).toBe(true)
    expect(m('node_modules/x/y.js')).toBe(false)
  })

  it('matches directory descendants with /** suffix', () => {
    const m = makeGlobMatcher(['**/node_modules/**'])!
    expect(m('node_modules/x/y.js')).toBe(true)
    expect(m('packages/a/node_modules/x.js')).toBe(true)
  })

  it('normalises backslashes and strips leading slash', () => {
    const m = makeGlobMatcher(['src/index.ts'])!
    expect(m('src\\index.ts')).toBe(true)
    expect(m('/src/index.ts')).toBe(true)
  })
})

describe('makeExcludeMatcher', () => {
  it('returns null for an empty object', () => {
    expect(makeExcludeMatcher({})).toBeNull()
  })

  it('returns null when every entry is false', () => {
    expect(makeExcludeMatcher({ '**/node_modules': false })).toBeNull()
  })

  it('only includes entries whose value is exactly true', () => {
    const m = makeExcludeMatcher({
      '**/node_modules': true,
      '**/dist': false,
      '**/.git': true,
    })!
    expect(m('node_modules')).toBe(true)
    expect(m('.git')).toBe(true)
    expect(m('dist')).toBe(false)
  })
})
