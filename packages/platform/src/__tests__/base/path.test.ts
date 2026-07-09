/*---------------------------------------------------------------------------------------------
 *  Tests for packages/platform/src/base/path.ts.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  arePathsEqual,
  basename,
  dirname,
  extname,
  getPathComparisonKey,
  isAbsolutePath,
  joinPath,
  normalizeDriveLetter,
  normalizeFsPath,
  pathSeparator,
  relativePath,
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

describe('path helpers for the variable resolver', () => {
  it('pathSeparator is platform-native', () => {
    expect(pathSeparator('win32')).toBe('\\')
    expect(pathSeparator('linux')).toBe('/')
    expect(pathSeparator('darwin')).toBe('/')
  })

  it('normalizeDriveLetter uppercases a leading drive only', () => {
    expect(normalizeDriveLetter('d:/foo')).toBe('D:/foo')
    expect(normalizeDriveLetter('/foo')).toBe('/foo')
    expect(normalizeDriveLetter('relative')).toBe('relative')
  })

  it('isAbsolutePath recognizes roots per platform', () => {
    expect(isAbsolutePath('C:/foo', 'win32')).toBe(true)
    expect(isAbsolutePath('C:\\foo', 'win32')).toBe(true)
    expect(isAbsolutePath('/foo', 'win32')).toBe(true)
    expect(isAbsolutePath('//host/share', 'win32')).toBe(true)
    expect(isAbsolutePath('foo/bar', 'win32')).toBe(false)
    expect(isAbsolutePath('C:/foo', 'linux')).toBe(false)
    expect(isAbsolutePath('/foo', 'linux')).toBe(true)
    expect(isAbsolutePath('', 'linux')).toBe(false)
  })

  it('joinPath joins with forward slashes and collapses dup separators', () => {
    expect(joinPath('/a', 'b', 'c')).toBe('/a/b/c')
    expect(joinPath('C:/proj', 'src')).toBe('C:/proj/src')
    expect(joinPath('/a/', '/b/')).toBe('/a/b/')
    expect(joinPath('a\\b', 'c')).toBe('a/b/c')
    expect(joinPath()).toBe('.')
  })

  it('basename returns the last segment', () => {
    expect(basename('/a/b/c.ts')).toBe('c.ts')
    expect(basename('/a/b/')).toBe('b')
    expect(basename('C:\\a\\b')).toBe('b')
    expect(basename('bare')).toBe('bare')
  })

  it('dirname returns the parent, keeping roots', () => {
    expect(dirname('/a/b/c.ts')).toBe('/a/b')
    expect(dirname('/a')).toBe('/')
    expect(dirname('C:/foo')).toBe('C:/')
    expect(dirname('bare')).toBe('.')
  })

  it('extname returns the extension including the dot', () => {
    expect(extname('a.ts')).toBe('.ts')
    expect(extname('/a/b.min.js')).toBe('.js')
    expect(extname('noext')).toBe('')
    expect(extname('.dotfile')).toBe('')
  })

  it('relativePath computes a relative path, climbing when needed', () => {
    expect(relativePath('/a/b', '/a/b/c', 'linux')).toBe('c')
    expect(relativePath('/a/b/c', '/a/b', 'linux')).toBe('..')
    expect(relativePath('/a/b', '/a/c', 'linux')).toBe('../c')
    expect(relativePath('/a/b', '/a/b', 'linux')).toBe('')
  })

  it('relativePath is case-insensitive on win32 and falls back across drives', () => {
    expect(relativePath('D:\\Proj', 'd:/proj/src', 'win32')).toBe('src')
    expect(relativePath('C:/a', 'D:/b', 'win32')).toBe('D:/b')
  })
})
