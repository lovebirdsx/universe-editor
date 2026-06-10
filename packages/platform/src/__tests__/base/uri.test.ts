/*---------------------------------------------------------------------------------------------
 *  Tests for packages/platform/src/base/uri.ts.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { URI, canonicalResourceKey, isEqualResource } from '../../base/uri.js'

describe('URI — parse', () => {
  it('parses scheme + authority + path + query + fragment', () => {
    const u = URI.parse('https://example.com/foo/bar?x=1&y=2#section')
    expect(u.scheme).toBe('https')
    expect(u.authority).toBe('example.com')
    expect(u.path).toBe('/foo/bar')
    expect(u.query).toBe('x=1&y=2')
    expect(u.fragment).toBe('section')
  })

  it('parses file:/// URI', () => {
    const u = URI.parse('file:///D:/foo/bar.lua')
    expect(u.scheme).toBe('file')
    expect(u.authority).toBe('')
    expect(u.path).toBe('/D:/foo/bar.lua')
  })

  it('parses scheme-only', () => {
    const u = URI.parse('mailto:')
    expect(u.scheme).toBe('mailto')
    expect(u.path).toBe('')
  })

  it('returns empty URI on totally invalid input', () => {
    const u = URI.parse('')
    expect(u.scheme).toBe('')
    expect(u.path).toBe('')
  })

  it('decodes percent-encoded path components', () => {
    const u = URI.parse('file:///foo%20bar/baz')
    expect(u.path).toBe('/foo bar/baz')
  })
})

describe('URI — file()', () => {
  it('builds file URI from Windows-style path', () => {
    const u = URI.file('D:/foo/bar.lua')
    expect(u.scheme).toBe('file')
    expect(u.path).toBe('/D:/foo/bar.lua')
    expect(u.toString()).toBe('file:///D:/foo/bar.lua')
  })

  it('builds file URI from backslash path', () => {
    const u = URI.file('D:\\foo\\bar.lua')
    expect(u.path).toBe('/D:/foo/bar.lua')
  })

  it('builds file URI from Unix path', () => {
    const u = URI.file('/usr/local/bin')
    expect(u.path).toBe('/usr/local/bin')
    expect(u.toString()).toBe('file:///usr/local/bin')
  })

  it('handles UNC path (//server/share)', () => {
    const u = URI.file('//server/share/file.txt')
    expect(u.authority).toBe('server')
    expect(u.path).toBe('/share/file.txt')
  })
})

describe('URI — from() / with()', () => {
  it('from constructs URI from components', () => {
    const u = URI.from({ scheme: 'universe', path: '/welcome' })
    expect(u.scheme).toBe('universe')
    expect(u.path).toBe('/welcome')
    expect(u.toString()).toBe('universe:/welcome')
  })

  it('with replaces only specified fields', () => {
    const u = URI.parse('https://example.com/foo')
    const u2 = u.with({ path: '/bar' })
    expect(u2.scheme).toBe('https')
    expect(u2.authority).toBe('example.com')
    expect(u2.path).toBe('/bar')
  })

  it('with returns same instance when nothing changes', () => {
    const u = URI.parse('https://example.com/foo')
    const u2 = u.with({ path: '/foo' })
    expect(u2).toBe(u)
  })

  it('with null clears a component', () => {
    const u = URI.parse('https://example.com/foo?q=1')
    const u2 = u.with({ query: null })
    expect(u2.query).toBe('')
  })

  it('from throws on invalid scheme', () => {
    expect(() => URI.from({ scheme: '!bad' })).toThrow(/Scheme contains illegal characters/)
  })
})

describe('URI — joinPath()', () => {
  it('joins path segments', () => {
    const base = URI.file('D:/foo')
    const joined = URI.joinPath(base, 'sub', 'file.txt')
    expect(joined.path).toBe('/D:/foo/sub/file.txt')
  })

  it('handles trailing/leading slashes', () => {
    const base = URI.file('D:/foo/')
    const joined = URI.joinPath(base, '/sub/', '/file.txt')
    expect(joined.path).toBe('/D:/foo/sub/file.txt')
  })

  it('resolves ..', () => {
    const base = URI.file('D:/foo/bar')
    const joined = URI.joinPath(base, '..', 'baz')
    expect(joined.path).toBe('/D:/foo/baz')
  })

  it('throws when base has no path', () => {
    const base = URI.from({ scheme: 'mailto' })
    expect(() => URI.joinPath(base, 'sub')).toThrow(/cannot call joinPath on URI without path/)
  })
})

describe('URI — toString() / toJSON() / revive()', () => {
  it('toString roundtrips simple file URI', () => {
    const u = URI.file('/usr/bin')
    expect(URI.parse(u.toString()).path).toBe('/usr/bin')
  })

  it('toString encodes special characters in path', () => {
    const u = URI.from({ scheme: 'file', path: '/foo bar/baz' })
    expect(u.toString()).toBe('file:///foo%20bar/baz')
  })

  it('toJSON includes only non-empty components', () => {
    const u = URI.from({ scheme: 'universe', path: '/welcome' })
    const json = u.toJSON()
    expect(json.$mid).toBe(1)
    expect(json.scheme).toBe('universe')
    expect(json.path).toBe('/welcome')
    expect(json.authority).toBeUndefined()
    expect(json.query).toBeUndefined()
  })

  it('revive turns JSON back into URI', () => {
    const original = URI.parse('https://example.com/foo?q=1')
    const data = JSON.parse(JSON.stringify(original))
    const revived = URI.revive(data)
    expect(revived).toBeInstanceOf(URI)
    expect(revived!.toString()).toBe(original.toString())
  })

  it('revive of URI instance returns the same instance', () => {
    const u = URI.parse('file:///foo')
    expect(URI.revive(u)).toBe(u)
  })

  it('revive of null/undefined returns the same value', () => {
    expect(URI.revive(null)).toBeNull()
    expect(URI.revive(undefined)).toBeUndefined()
  })
})

describe('URI — fsPath', () => {
  it('strips leading slash before Windows drive', () => {
    const u = URI.file('D:/foo/bar.lua')
    expect(u.fsPath).toBe('D:/foo/bar.lua')
  })

  it('preserves Unix absolute path', () => {
    const u = URI.file('/usr/bin')
    expect(u.fsPath).toBe('/usr/bin')
  })

  it('includes authority for UNC paths', () => {
    const u = URI.file('//server/share/file.txt')
    expect(u.fsPath).toBe('//server/share/file.txt')
  })
})

describe('URI — isUri', () => {
  it('returns true for URI instances', () => {
    expect(URI.isUri(URI.parse('file:///foo'))).toBe(true)
  })

  it('returns true for shape-compatible objects', () => {
    expect(URI.isUri({ scheme: 'http' })).toBe(true)
  })

  it('returns false for non-objects', () => {
    expect(URI.isUri(null)).toBe(false)
    expect(URI.isUri('string')).toBe(false)
    expect(URI.isUri(42)).toBe(false)
  })
})

describe('URI — isEqualResource', () => {
  it('treats the Windows drive letter case-insensitively', () => {
    // The editor keeps the uppercase drive; a value round-tripped through Monaco
    // arrives lower-cased + percent-encoded — both must compare equal.
    expect(
      isEqualResource(URI.parse('file:///D:/x/Foo.ts'), URI.parse('file:///d%3A/x/Foo.ts')),
    ).toBe(true)
  })

  it('still distinguishes different paths', () => {
    expect(
      isEqualResource(URI.parse('file:///D:/x/Foo.ts'), URI.parse('file:///D:/x/Bar.ts')),
    ).toBe(false)
  })

  it('keeps the rest of the path case-sensitive', () => {
    expect(
      isEqualResource(URI.parse('file:///D:/x/Foo.ts'), URI.parse('file:///d:/X/Foo.ts')),
    ).toBe(false)
  })

  it('is undefined-safe', () => {
    expect(isEqualResource(undefined, undefined)).toBe(true)
    expect(isEqualResource(URI.parse('file:///D:/x'), undefined)).toBe(false)
  })

  it('canonicalResourceKey lower-cases only the leading drive letter', () => {
    expect(canonicalResourceKey(URI.parse('file:///D:/x/Foo.ts'))).toBe('file:///d:/x/Foo.ts')
    expect(canonicalResourceKey(URI.parse('file:///usr/Bin'))).toBe('file:///usr/Bin')
  })
})
