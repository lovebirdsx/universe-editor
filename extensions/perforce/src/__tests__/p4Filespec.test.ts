import { describe, expect, it } from 'vitest'
import { buildScopeFilespec, buildSyncFilespecs, escapeFilespecPath } from '../p4Filespec.js'

describe('escapeFilespecPath', () => {
  it('escapes each metacharacter to its percent form', () => {
    expect(escapeFilespecPath('a@b')).toBe('a%40b')
    expect(escapeFilespecPath('a#b')).toBe('a%23b')
    expect(escapeFilespecPath('a*b')).toBe('a%2Ab')
    expect(escapeFilespecPath('a%b')).toBe('a%25b')
  })

  it('escapes combinations in one pass without double-escaping', () => {
    expect(escapeFilespecPath('a@b#c%d*e')).toBe('a%40b%23c%25d%2Ae')
  })

  it('escapes % first so an introduced % is not re-escaped', () => {
    expect(escapeFilespecPath('100%')).toBe('100%25')
    expect(escapeFilespecPath('%40')).toBe('%2540')
  })
})

describe('buildScopeFilespec', () => {
  it('builds a recursive directory scope', () => {
    expect(buildScopeFilespec('X:/p4ws/main', true)).toBe('X:/p4ws/main/...')
  })

  it('trims a single trailing separator in directory scopes', () => {
    expect(buildScopeFilespec('X:/p4ws/main/', true)).toBe('X:/p4ws/main/...')
    expect(buildScopeFilespec('X:\\p4ws\\main\\', true)).toBe('X:\\p4ws\\main/...')
  })

  it('trims multiple trailing separators in directory scopes', () => {
    expect(buildScopeFilespec('X:/p4ws/main//', true)).toBe('X:/p4ws/main/...')
    expect(buildScopeFilespec('X:\\p4ws\\main\\\\', true)).toBe('X:\\p4ws\\main/...')
  })

  it('builds a file scope without appending /...', () => {
    expect(buildScopeFilespec('X:/p4ws/main/a.txt', false)).toBe('X:/p4ws/main/a.txt')
  })

  it('escapes metacharacters in both directory and file scopes', () => {
    expect(buildScopeFilespec('X:/p4ws/@dir#1', true)).toBe('X:/p4ws/%40dir%231/...')
    expect(buildScopeFilespec('X:/p4ws/main/a@1.txt', false)).toBe('X:/p4ws/main/a%401.txt')
    expect(buildScopeFilespec('X:/p4ws/main/a 100%.txt', false)).toBe('X:/p4ws/main/a 100%25.txt')
  })

  it('handles empty and separator-only input without crashing', () => {
    expect(buildScopeFilespec('', false)).toBe('')
    expect(buildScopeFilespec('', true)).toBe('/...')
    expect(buildScopeFilespec('/', true)).toBe('/...')
    expect(buildScopeFilespec('\\', true)).toBe('/...')
  })
})

describe('buildSyncFilespecs', () => {
  it('returns an empty list for no targets', () => {
    expect(buildSyncFilespecs([])).toEqual([])
  })

  it('passes a single file through escaped, without a revision suffix', () => {
    expect(buildSyncFilespecs([{ path: 'X:/ws/a.txt', isDirectory: false }])).toEqual([
      'X:/ws/a.txt',
    ])
  })

  it('escapes metacharacters in every entry', () => {
    expect(
      buildSyncFilespecs([
        { path: 'X:/ws/a@1#2%3.txt', isDirectory: false },
        { path: 'X:/ws/d@1', isDirectory: true },
      ]),
    ).toEqual(['X:/ws/a%401%232%253.txt', 'X:/ws/d%401/...'])
  })

  it('expands directories to recursive filespecs, trimming trailing separators', () => {
    expect(buildSyncFilespecs([{ path: 'X:/ws/src/', isDirectory: true }])).toEqual([
      'X:/ws/src/...',
    ])
    expect(buildSyncFilespecs([{ path: 'X:\\ws\\src\\', isDirectory: true }])).toEqual([
      'X:\\ws\\src/...',
    ])
  })

  it('drops files nested under a selected directory', () => {
    expect(
      buildSyncFilespecs([
        { path: 'X:/ws/src', isDirectory: true },
        { path: 'X:/ws/src/a.txt', isDirectory: false },
        { path: 'X:/ws/other.txt', isDirectory: false },
      ]),
    ).toEqual(['X:/ws/src/...', 'X:/ws/other.txt'])
  })

  it('drops subdirectories nested under a selected directory', () => {
    expect(
      buildSyncFilespecs([
        { path: 'X:/ws/src', isDirectory: true },
        { path: 'X:/ws/src/sub', isDirectory: true },
      ]),
    ).toEqual(['X:/ws/src/...'])
  })

  it('drops nested subdirectories regardless of input order', () => {
    expect(
      buildSyncFilespecs([
        { path: 'X:/ws/src/sub', isDirectory: true },
        { path: 'X:/ws/src', isDirectory: true },
        { path: 'X:/ws/src/sub/deep.txt', isDirectory: false },
      ]),
    ).toEqual(['X:/ws/src/...'])
  })

  it('keeps a path that merely shares a name prefix with a selected directory', () => {
    expect(
      buildSyncFilespecs([
        { path: 'X:/ws/src', isDirectory: true },
        { path: 'X:/ws/srcother', isDirectory: false },
        { path: 'X:/ws/srcother/deep.txt', isDirectory: false },
      ]),
    ).toEqual(['X:/ws/src/...', 'X:/ws/srcother', 'X:/ws/srcother/deep.txt'])
  })

  it('dedupes repeated entries, folding drive-letter case', () => {
    expect(
      buildSyncFilespecs([
        { path: 'X:/ws/src', isDirectory: true },
        { path: 'x:/ws/src', isDirectory: true },
        { path: 'X:/ws/src', isDirectory: true },
      ]),
    ).toEqual(['X:/ws/src/...'])
  })

  it('drops empty paths', () => {
    expect(
      buildSyncFilespecs([
        { path: '', isDirectory: false },
        { path: 'X:/ws/a.txt', isDirectory: false },
      ]),
    ).toEqual(['X:/ws/a.txt'])
  })

  it('preserves input order', () => {
    expect(
      buildSyncFilespecs([
        { path: 'X:/ws/b.txt', isDirectory: false },
        { path: 'X:/ws/src', isDirectory: true },
        { path: 'X:/ws/a.txt', isDirectory: false },
      ]),
    ).toEqual(['X:/ws/b.txt', 'X:/ws/src/...', 'X:/ws/a.txt'])
  })
})
