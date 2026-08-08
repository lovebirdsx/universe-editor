import { describe, expect, it } from 'vitest'
import {
  filterAndSortMatches,
  matchesCamelCase,
  matchesContiguousSubString,
  matchesWords,
  orMatch,
  type IMatch,
} from '../text/wordMatching.js'

describe('matchesContiguousSubString', () => {
  it('matches a contiguous substring case-insensitively', () => {
    expect(matchesContiguousSubString('cela', 'cancelAnimationFrame()')).toEqual([
      { start: 3, end: 7 },
    ])
  })

  it('returns null when the word is longer or absent', () => {
    expect(matchesContiguousSubString('cancelAnimationFrames', 'cancelAnimationFrame')).toBeNull()
    expect(matchesContiguousSubString('xyz', 'cancelAnimationFrame()')).toBeNull()
  })
})

describe('matchesCamelCase', () => {
  it('rejects empty inputs', () => {
    expect(matchesCamelCase('', '')).toBeNull()
    expect(matchesCamelCase('', 'anything')).toEqual([])
    expect(matchesCamelCase('a', '')).toBeNull()
  })

  it('matches plain prefixes', () => {
    expect(matchesCamelCase('alpha', 'alpha')).toEqual([{ start: 0, end: 5 }])
    expect(matchesCamelCase('alpha', 'alphasomething')).toEqual([{ start: 0, end: 5 }])
    expect(matchesCamelCase('alpha', 'alp')).toBeNull()
  })

  it('matches camel humps', () => {
    expect(matchesCamelCase('cc', 'CamelCaseRocks')).toEqual([
      { start: 0, end: 1 },
      { start: 5, end: 6 },
    ])
    expect(matchesCamelCase('ccr', 'CamelCaseRocks')).toEqual([
      { start: 0, end: 1 },
      { start: 5, end: 6 },
      { start: 9, end: 10 },
    ])
    expect(matchesCamelCase('cacr', 'CamelCaseRocks')).toEqual([
      { start: 0, end: 2 },
      { start: 5, end: 6 },
      { start: 9, end: 10 },
    ])
    expect(matchesCamelCase('cr', 'CamelCaseRocks')).toEqual([
      { start: 0, end: 1 },
      { start: 9, end: 10 },
    ])
  })

  it('continues past humps within a word', () => {
    expect(matchesCamelCase('fba', 'FooBarAbe')).toEqual([
      { start: 0, end: 1 },
      { start: 3, end: 5 },
    ])
    expect(matchesCamelCase('fbara', 'FooBarAbe')).toEqual([
      { start: 0, end: 1 },
      { start: 3, end: 7 },
    ])
    expect(matchesCamelCase('c2d', 'canvasCreation2D')).toEqual([
      { start: 0, end: 1 },
      { start: 14, end: 16 },
    ])
  })

  it('anchors after non-alphanumeric characters', () => {
    expect(matchesCamelCase('cce', '_canvasCreationEvent')).toEqual([
      { start: 1, end: 2 },
      { start: 7, end: 8 },
      { start: 15, end: 16 },
    ])
  })

  it('matches phrases with separators', () => {
    expect(matchesCamelCase('Debug Console', 'Open: Debug Console')).not.toBeNull()
    expect(matchesCamelCase('debug console', 'Open: Debug Console')).not.toBeNull()
  })
})

describe('matchesWords', () => {
  it('matches word prefixes', () => {
    expect(matchesWords('alpha', 'alpha')).toEqual([{ start: 0, end: 5 }])
    expect(matchesWords('alpha', 'alphasomething')).toEqual([{ start: 0, end: 5 }])
    expect(matchesWords('alpha', 'alp')).toBeNull()
    expect(matchesWords('a', 'alpha')).toEqual([{ start: 0, end: 1 }])
    expect(matchesWords('x', 'alpha')).toBeNull()
    expect(matchesWords('A', 'alpha')).toEqual([{ start: 0, end: 1 }])
  })

  it('hops between words in the target', () => {
    expect(matchesWords('gp', 'Git: Pull')).toEqual([
      { start: 0, end: 1 },
      { start: 5, end: 6 },
    ])
    expect(matchesWords('g p', 'Git: Pull')).toEqual([
      { start: 0, end: 1 },
      { start: 5, end: 6 },
    ])
    expect(matchesWords('gipu', 'Git: Pull')).toEqual([
      { start: 0, end: 2 },
      { start: 5, end: 7 },
    ])
    expect(matchesWords('gp', 'Category: Git: Pull')).toEqual([
      { start: 10, end: 11 },
      { start: 15, end: 16 },
    ])
    expect(matchesWords('gipu', 'Category: Git: Pull')).toEqual([
      { start: 10, end: 12 },
      { start: 15, end: 17 },
    ])
  })

  it('rejects intra-word matches when hopping', () => {
    expect(matchesWords('it', 'Git: Pull')).toBeNull()
    expect(matchesWords('ll', 'Git: Pull')).toBeNull()
  })

  it('treats separators as an equivalence class without highlighting them', () => {
    expect(matchesWords('.', ':')).toEqual([])
    expect(matchesWords('.', '.')).toEqual([{ start: 0, end: 1 }])
    expect(matchesWords('foo-bar', 'foo bar')).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 7 },
    ])
    expect(matchesWords('foo bar', 'foo-bar')).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 7 },
    ])
    expect(matchesWords('Debug Console', 'Open: Debug Console')).not.toBeNull()
  })

  it('matches words anywhere in the target', () => {
    expect(matchesWords('bar', 'foo-bar')).not.toBeNull()
    expect(matchesWords('bar test', 'foo-bar test')).not.toBeNull()
    expect(matchesWords('fbt', 'foo-bar test')).not.toBeNull()
    expect(matchesWords('bar test', 'foo-bar (test)')).not.toBeNull()
    expect(matchesWords('foo bar', 'foo (bar)')).not.toBeNull()
    expect(matchesWords('foo bar', '123 foo-bar 456')).not.toBeNull()

    expect(matchesWords('bar est', 'foo-bar test')).toBeNull()
    expect(matchesWords('fo ar', 'foo-bar test')).toBeNull()
    expect(matchesWords('for', 'foo-bar test')).toBeNull()
  })

  it('contiguous mode requires consuming target words from their start', () => {
    expect(matchesWords('pul', 'Git: Pull', true)).toEqual([{ start: 5, end: 8 }])
    expect(matchesWords('gp', 'Git: Pull', true)).toBeNull()
    expect(matchesWords('gipu', 'Git: Pull', true)).toBeNull()
  })

  it('does not blow up on separator-heavy queries (#309582)', () => {
    expect(
      matchesWords('editor.action..........', 'workbench.action.editor.action.someCommand'),
    ).toBeNull()
  })
})

describe('orMatch', () => {
  it('returns the first matching filter result', () => {
    const calls: string[] = []
    const filter = (name: string, result: IMatch[] | null) => (): IMatch[] | null => {
      calls.push(name)
      return result
    }

    expect(orMatch(filter('a', null), filter('b', [{ start: 0, end: 1 }]))('x', 'y')).toEqual([
      { start: 0, end: 1 },
    ])
    expect(calls).toEqual(['a', 'b'])

    calls.length = 0
    expect(
      orMatch(filter('a', [{ start: 0, end: 1 }]), filter('b', [{ start: 1, end: 2 }]))('x', 'y'),
    ).toEqual([{ start: 0, end: 1 }])
    expect(calls).toEqual(['a'])

    expect(orMatch(filter('a', null), filter('b', null))('x', 'y')).toBeNull()
  })
})

describe('filterAndSortMatches', () => {
  it('dedupes identical intervals', () => {
    expect(
      filterAndSortMatches([
        { start: 0, end: 2 },
        { start: 0, end: 2 },
      ]),
    ).toEqual([{ start: 0, end: 2 }])
  })

  it('drops intervals fully contained in another', () => {
    expect(
      filterAndSortMatches([
        { start: 5, end: 6 },
        { start: 0, end: 10 },
        { start: 2, end: 4 },
      ]),
    ).toEqual([{ start: 0, end: 10 }])
  })

  it('keeps overlapping but not contained intervals and sorts by start', () => {
    expect(
      filterAndSortMatches([
        { start: 4, end: 8 },
        { start: 0, end: 5 },
        { start: 10, end: 11 },
      ]),
    ).toEqual([
      { start: 0, end: 5 },
      { start: 4, end: 8 },
      { start: 10, end: 11 },
    ])
  })

  it('returns an empty array for no matches', () => {
    expect(filterAndSortMatches([])).toEqual([])
  })
})
