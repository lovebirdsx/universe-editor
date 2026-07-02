/*---------------------------------------------------------------------------------------------
 *  Tests for packages/platform/src/base/path.ts.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  arePathsEqual,
  getPathComparisonKey,
  normalizeFsPath,
  relativePathUnder,
} from '../../base/path.js'

describe('normalizeFsPath', () => {
  it('converts backslashes to forward slashes', () => {
    expect(normalizeFsPath('D:\\a\\b')).toBe('D:/a/b')
  })

  it('uppercases Windows drive letters', () => {
    expect(normalizeFsPath('d:/a')).toBe('D:/a')
    expect(normalizeFsPath('c:\\Users\\x')).toBe('C:/Users/x')
  })

  it('strips trailing slash but keeps bare root', () => {
    expect(normalizeFsPath('/foo/')).toBe('/foo')
    expect(normalizeFsPath('/')).toBe('/')
    expect(normalizeFsPath('D:/')).toBe('D:')
  })

  it('collapses . and .. segments', () => {
    expect(normalizeFsPath('/a/./b')).toBe('/a/b')
    expect(normalizeFsPath('/a/b/../c')).toBe('/a/c')
    expect(normalizeFsPath('D:\\a\\.\\b\\..\\c')).toBe('D:/a/c')
  })

  it('marks paths that escape the root with __ESCAPED__ prefix', () => {
    expect(normalizeFsPath('/../x').startsWith('__ESCAPED__')).toBe(true)
    expect(normalizeFsPath('../x').startsWith('__ESCAPED__')).toBe(true)
  })
})

describe('arePathsEqual', () => {
  it('returns true for trivially identical posix paths on linux', () => {
    expect(arePathsEqual('/Users/x/proj', '/Users/x/proj', 'linux')).toBe(true)
  })

  it('treats trailing slash and `.` segment as equal', () => {
    expect(arePathsEqual('/Users/x/proj', '/Users/x/proj/', 'linux')).toBe(true)
    expect(arePathsEqual('/Users/x/proj', '/Users/x/proj/.', 'linux')).toBe(true)
  })

  it('is case-sensitive on linux', () => {
    expect(arePathsEqual('/Foo', '/foo', 'linux')).toBe(false)
  })

  it('is case-insensitive on win32', () => {
    expect(arePathsEqual('D:\\Foo', 'd:/foo', 'win32')).toBe(true)
    expect(arePathsEqual('C:\\Users\\Alice', 'c:/users/alice', 'win32')).toBe(true)
  })

  it('is case-insensitive on darwin', () => {
    expect(arePathsEqual('/Users/Alice/Proj', '/users/alice/proj', 'darwin')).toBe(true)
  })

  it('normalizes mixed separators before comparing on win32', () => {
    expect(arePathsEqual('D:\\a\\b', 'D:/a/b', 'win32')).toBe(true)
  })

  it('treats undefined and empty inputs as unequal', () => {
    expect(arePathsEqual(undefined, undefined, 'linux')).toBe(false)
    expect(arePathsEqual('', '', 'linux')).toBe(false)
    expect(arePathsEqual('/a', undefined, 'linux')).toBe(false)
    expect(arePathsEqual(undefined, '/a', 'linux')).toBe(false)
  })

  it('rejects inputs that escape the filesystem root', () => {
    expect(arePathsEqual('../x', '../x', 'linux')).toBe(false)
    expect(arePathsEqual('/../x', '/../x', 'linux')).toBe(false)
  })

  it('distinguishes different drives on win32', () => {
    expect(arePathsEqual('C:\\a', 'D:\\a', 'win32')).toBe(false)
  })
})

describe('getPathComparisonKey', () => {
  it('agrees with arePathsEqual: equal paths share a key', () => {
    // Same normalize + case policy, so a keyed collection never disagrees with a
    // pairwise arePathsEqual check.
    expect(getPathComparisonKey('D:\\a\\B', 'win32')).toBe(getPathComparisonKey('d:/a/b', 'win32'))
    expect(getPathComparisonKey('/a/B', 'linux')).not.toBe(getPathComparisonKey('/a/b', 'linux'))
  })

  it('folds drive-letter + path case only on case-insensitive platforms', () => {
    expect(getPathComparisonKey('d:/A/b', 'win32')).toBe('d:/a/b')
    expect(getPathComparisonKey('d:/A/b', 'darwin')).toBe('d:/a/b')
    expect(getPathComparisonKey('/A/b', 'linux')).toBe('/A/b')
  })

  it('keeps escaped paths distinct rather than collapsing them', () => {
    // Unlike arePathsEqual (which refuses escaped paths), the key retains the
    // marker so two different escaped paths still get two different keys.
    const a = getPathComparisonKey('../a', 'linux')
    const b = getPathComparisonKey('../b', 'linux')
    expect(a).not.toBe(b)
    expect(a.startsWith('__ESCAPED__')).toBe(true)
  })
})

describe('relativePathUnder', () => {
  it('returns empty string when child equals parent', () => {
    expect(relativePathUnder('/a/b', '/a/b', 'linux')).toBe('')
    expect(relativePathUnder('/a/b/', '/a/b', 'linux')).toBe('')
  })

  it('returns the suffix when child is under parent', () => {
    expect(relativePathUnder('/a', '/a/b/c', 'linux')).toBe('b/c')
  })

  it('returns null when child is not under parent', () => {
    expect(relativePathUnder('/a/b', '/a/c', 'linux')).toBeNull()
    expect(relativePathUnder('/a/b', '/a', 'linux')).toBeNull()
  })

  it('returns null across different Windows drives', () => {
    expect(relativePathUnder('C:\\a', 'D:\\a', 'win32')).toBeNull()
  })

  it('is case-insensitive on win32 / darwin', () => {
    expect(relativePathUnder('D:\\Proj', 'd:/proj/src', 'win32')).toBe('src')
    expect(relativePathUnder('/Users/Alice', '/users/alice/notes', 'darwin')).toBe('notes')
  })

  it('is case-sensitive on linux', () => {
    expect(relativePathUnder('/Foo', '/foo/bar', 'linux')).toBeNull()
  })

  it('returns null when either side is empty', () => {
    expect(relativePathUnder('', '/a', 'linux')).toBeNull()
    expect(relativePathUnder('/a', '', 'linux')).toBeNull()
  })

  it('returns null when either side escapes the filesystem root', () => {
    expect(relativePathUnder('../a', '../a/b', 'linux')).toBeNull()
    expect(relativePathUnder('/a', '/a/../../b', 'linux')).toBeNull()
  })

  it('preserves original casing in the returned relative segment', () => {
    expect(relativePathUnder('D:\\Proj', 'D:/Proj/SRC/Foo.ts', 'win32')).toBe('SRC/Foo.ts')
  })
})
