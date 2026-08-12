/**
 * Tests for the `Uri` class: file/parse/from/joinPath factories, fsPath branches
 * (Windows drive + UNC), toString encoding and round-trips.
 */
import { describe, expect, it } from 'vitest'
import { Uri } from '../uri.js'

const isWindows = process.platform === 'win32'

describe('Uri.file', () => {
  it('canonicalizes a Windows drive path to a leading-slash path', () => {
    const uri = Uri.file('C:\\x\\y')
    expect(uri.scheme).toBe('file')
    expect(uri.authority).toBe('')
    expect(uri.path).toBe('/C:/x/y')
    expect(uri.toString()).toBe('file:///C:/x/y')
  })

  it('keeps the drive-letter case in path and accepts forward slashes', () => {
    expect(Uri.file('c:/x/y').path).toBe('/c:/x/y')
    expect(Uri.file('D:/Foo/Bar.txt').path).toBe('/D:/Foo/Bar.txt')
  })

  it('maps a UNC path onto the authority', () => {
    const uri = Uri.file('\\\\server\\share\\dir\\f.txt')
    expect(uri.authority).toBe('server')
    expect(uri.path).toBe('/share/dir/f.txt')
    expect(uri.toString()).toBe('file://server/share/dir/f.txt')
  })

  it('leaves a posix path untouched', () => {
    const uri = Uri.file('/home/u/a.txt')
    expect(uri.path).toBe('/home/u/a.txt')
    expect(uri.toString()).toBe('file:///home/u/a.txt')
  })
})

describe('Uri.parse / toString round-trip', () => {
  it('round-trips a file URI with a drive letter', () => {
    const uri = Uri.parse('file:///C:/x/y')
    expect(uri.scheme).toBe('file')
    expect(uri.authority).toBe('')
    expect(uri.path).toBe('/C:/x/y')
    expect(uri.toString()).toBe('file:///C:/x/y')
  })

  it('decodes percent-encoded components and re-encodes on toString', () => {
    const uri = Uri.parse('https://example.com/a%20b?q=a%20b#frag%20ment')
    expect(uri.scheme).toBe('https')
    expect(uri.authority).toBe('example.com')
    expect(uri.path).toBe('/a b')
    expect(uri.query).toBe('q=a b')
    expect(uri.fragment).toBe('frag ment')
    expect(uri.toString()).toBe('https://example.com/a%20b?q=a%20b#frag%20ment')
  })

  it('encodes the delimiter characters # and ? inside the path', () => {
    const uri = Uri.parse('file:///a%23b%3Fc')
    expect(uri.path).toBe('/a#b?c')
    expect(uri.toString()).toBe('file:///a%23b%3Fc')
  })

  it('round-trips a custom scheme', () => {
    const uri = Uri.parse('universe-editor://file/D:/repo/a.ts')
    expect(uri.scheme).toBe('universe-editor')
    expect(uri.authority).toBe('file')
    expect(uri.path).toBe('/D:/repo/a.ts')
    expect(uri.toString()).toBe('universe-editor://file/D:/repo/a.ts')
  })

  it('with skipEncoding only the delimiter characters are encoded', () => {
    expect(Uri.parse('file:///a%20b').toString(true)).toBe('file:///a b')
    expect(Uri.file('/a b').toString(true)).toBe('file:///a b')
    expect(Uri.parse('file:///a%23b').toString(true)).toBe('file:///a%23b')
  })

  it('strict mode throws on a missing or illegal scheme', () => {
    expect(() => Uri.parse('no scheme here', true)).toThrow()
    expect(() => Uri.parse('https://example.com', true)).not.toThrow()
  })
})

describe('Uri.joinPath', () => {
  it('joins segments with a single slash', () => {
    expect(Uri.joinPath(Uri.parse('file:///a/b'), 'c', 'd').path).toBe('/a/b/c/d')
    expect(Uri.joinPath(Uri.parse('file:///a/b/'), '/c/').path).toBe('/a/b/c')
  })

  it('resolves .. and . segments', () => {
    expect(Uri.joinPath(Uri.parse('file:///a/b'), '..', 'c').path).toBe('/a/c')
    expect(Uri.joinPath(Uri.parse('file:///a/b'), './c').path).toBe('/a/b/c')
    expect(Uri.joinPath(Uri.parse('file:///a'), '..', '..', 'x').path).toBe('/x')
  })

  it('keeps scheme and authority, drops nothing else', () => {
    const joined = Uri.joinPath(Uri.parse('file://server/share'), 'dir', 'f.txt')
    expect(joined.authority).toBe('server')
    expect(joined.path).toBe('/share/dir/f.txt')
  })

  it('throws when the base has no path', () => {
    expect(() => Uri.joinPath(Uri.parse('https://example.com'), 'x')).toThrow()
  })
})

describe('Uri.fsPath', () => {
  it('drive branch: strips the leading slash and lower-cases the drive letter', () => {
    const expected = isWindows ? 'c:\\x\\y' : 'c:/x/y'
    expect(Uri.parse('file:///c:/x/y').fsPath).toBe(expected)
    expect(Uri.parse('file:///C:/x/y').fsPath).toBe(expected)
    expect(Uri.file('C:\\x\\y').fsPath).toBe(expected)
  })

  it('UNC branch: folds the authority into a //server/share path', () => {
    const expected = isWindows ? '\\\\server\\share\\x' : '//server/share/x'
    expect(Uri.parse('file://server/share/x').fsPath).toBe(expected)
    expect(Uri.file('\\\\server\\share\\x').fsPath).toBe(expected)
  })

  it('non-file paths pass through', () => {
    const expected = isWindows ? '\\a\\b' : '/a/b'
    expect(Uri.parse('untitled:/a/b').fsPath).toBe(expected)
  })
})

describe('Uri.from / toJSON', () => {
  it('builds from components and validates the scheme', () => {
    const uri = Uri.from({ scheme: 'file', path: '/c:/x' })
    expect(uri.path).toBe('/c:/x')
    expect(uri.authority).toBe('')
    expect(() => Uri.from({ scheme: '1bad' })).toThrow()
    expect(() => Uri.from({} as never)).toThrow()
  })

  it('toJSON carries only the non-empty components', () => {
    expect(Uri.file('C:\\x').toJSON()).toEqual({ scheme: 'file', path: '/C:/x' })
    expect(Uri.parse('https://ex.com/p?q=1#f').toJSON()).toEqual({
      scheme: 'https',
      authority: 'ex.com',
      path: '/p',
      query: 'q=1',
      fragment: 'f',
    })
  })

  it('from(toJSON()) round-trips', () => {
    const uri = Uri.parse('https://ex.com/a%20b?q=1#f')
    const revived = Uri.from(uri.toJSON())
    expect(revived.toString()).toBe(uri.toString())
  })
})
