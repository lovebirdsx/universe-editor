/*---------------------------------------------------------------------------------------------
 *  The shared URI behaviour table (see @universe-editor/primitives/testing) run against the
 *  kernel's `URI`, plus the rows that pin where the kernel deliberately differs from the
 *  extension SDK's `Uri` — those differences are a contract, not an oversight.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import {
  FILE_CASES,
  FORMAT_CASES,
  FORMAT_THROWS_URIERROR,
  FS_PATH_CASES,
  JOIN_PATH_CASES,
  PARSE_CASES,
} from '@universe-editor/primitives/testing'
import { URI } from '../../base/uri.js'

describe('URI — shared table: parse', () => {
  for (const c of PARSE_CASES) {
    it(`parses ${c.name}`, () => {
      const uri = URI.parse(c.parse)
      expect({
        scheme: uri.scheme,
        authority: uri.authority,
        path: uri.path,
        query: uri.query,
        fragment: uri.fragment,
      }).toEqual({
        scheme: c.scheme,
        authority: c.authority,
        path: c.path,
        query: c.query,
        fragment: c.fragment,
      })
      if (c.stringForm !== undefined) {
        expect(uri.toString()).toBe(c.stringForm)
        // toString output is a resource identity (comparison keys, storage buckets,
        // watcher events) — it must survive a reparse byte for byte.
        expect(URI.parse(uri.toString()).toString()).toBe(c.stringForm)
      }
    })
  }
})

describe('URI — shared table: format', () => {
  for (const c of FORMAT_CASES) {
    it(`formats ${c.name}`, () => {
      expect(URI.from(c.components).toString()).toBe(c.stringForm)
    })
  }

  for (const c of FORMAT_THROWS_URIERROR) {
    it(`throws URIError on ${c.name}`, () => {
      expect(() => URI.from(c.components).toString()).toThrow(URIError)
    })
  }
})

describe('URI — shared table: file()', () => {
  for (const c of FILE_CASES) {
    it(`normalizes ${c.name}`, () => {
      const uri = URI.file(c.input)
      expect({ scheme: uri.scheme, authority: uri.authority, path: uri.path }).toEqual({
        scheme: 'file',
        authority: c.authority,
        path: c.path,
      })
      expect(uri.toString()).toBe(c.stringForm)
    })
  }
})

describe('URI — shared table: joinPath()', () => {
  for (const c of JOIN_PATH_CASES) {
    it(`${c.name}`, () => {
      const joined = URI.joinPath(URI.parse(c.base), ...c.segments)
      expect(joined.path).toBe(c.path)
      if (c.authority !== undefined) expect(joined.authority).toBe(c.authority)
    })
  }
})

describe('URI — shared table: fsPath (kernel policy)', () => {
  for (const c of FS_PATH_CASES) {
    it(`never re-writes separators or the drive letter on ${c.name}`, () => {
      expect(URI.from(c.uri).fsPath).toBe(c.kernel)
    })
  }
})

describe('URI — kernel-only behaviour (divergences from the SDK)', () => {
  it('toJSON carries `$mid: 1` for the RPC codec', () => {
    const json = URI.from({ scheme: 'universe', path: '/welcome' }).toJSON()
    expect(json.$mid).toBe(1)
    expect(json.scheme).toBe('universe')
    expect(json.path).toBe('/welcome')
    expect(json.authority).toBeUndefined()
  })

  it('revive restores instances and passes null/undefined through', () => {
    const original = URI.parse('https://example.com/foo?q=1')
    const revived = URI.revive(JSON.parse(JSON.stringify(original)))
    expect(revived).toBeInstanceOf(URI)
    expect(revived!.toString()).toBe(original.toString())
    expect(URI.revive(original)).toBe(original)
    expect(URI.revive(null)).toBeNull()
    expect(URI.revive(undefined)).toBeUndefined()
  })

  it('with() returns the same instance when nothing changes', () => {
    const uri = URI.parse('https://example.com/foo')
    expect(uri.with({ path: '/foo' })).toBe(uri)
  })

  it('joinPath() returns the same instance when the path is already normalized', () => {
    const uri = URI.file('D:/foo')
    expect(URI.joinPath(uri)).toBe(uri)
    expect(URI.joinPath(uri, '')).toBe(uri)
  })

  it('from() allows an empty scheme but rejects an illegal one', () => {
    expect(URI.from({ scheme: '', path: '/welcome' }).scheme).toBe('')
    expect(() => URI.from({ scheme: '!bad' })).toThrow(/Scheme contains illegal characters/)
  })

  it('joinPath() rejects a base without a path', () => {
    expect(() => URI.joinPath(URI.from({ scheme: 'mailto' }), 'sub')).toThrow(
      /cannot call joinPath on URI without path/,
    )
  })

  it('parse() has no strict mode — it yields an empty URI instead of throwing', () => {
    expect(URI.parse('no scheme here').scheme).toBe('')
  })

  it('toString() takes no skipEncoding argument', () => {
    expect(URI.prototype.toString.length).toBe(0)
  })
})
