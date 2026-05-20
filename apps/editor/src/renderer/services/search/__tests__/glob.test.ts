/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/search/glob.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { makeGlobMatcher } from '../glob.js'

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

  it('multiple patterns OR together', () => {
    const m = makeGlobMatcher(['**/*.ts', '**/*.tsx'])!
    expect(m('a.ts')).toBe(true)
    expect(m('a.tsx')).toBe(true)
    expect(m('a.js')).toBe(false)
  })

  it('normalises backslashes and strips leading slash', () => {
    const m = makeGlobMatcher(['src/index.ts'])!
    expect(m('src\\index.ts')).toBe(true)
    expect(m('/src/index.ts')).toBe(true)
  })
})
