/**
 * The shared URI behaviour table (see @universe-editor/primitives/testing) run against the
 * extension SDK's `Uri`, plus the rows that pin where the SDK deliberately differs from the
 * kernel's `URI` — the strict/`skipEncoding` surface is the vscode.d.ts shape.
 */
import { describe, expect, it } from 'vitest'
import {
  FILE_CASES,
  FORMAT_CASES,
  FORMAT_THROWS_URIERROR,
  FS_PATH_CASES,
  JOIN_PATH_CASES,
  PARSE_CASES,
} from '@universe-editor/primitives/testing'
import { Uri } from '../uri.js'

const isWindows = process.platform === 'win32'

describe('Uri — shared table: parse', () => {
  for (const c of PARSE_CASES) {
    it(`parses ${c.name}`, () => {
      const uri = Uri.parse(c.parse)
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
        expect(Uri.parse(uri.toString()).toString()).toBe(c.stringForm)
      }
      if (c.skipEncodingForm !== undefined) {
        expect(uri.toString(true)).toBe(c.skipEncodingForm)
      }
    })
  }
})

describe('Uri — shared table: format', () => {
  for (const c of FORMAT_CASES) {
    it(`formats ${c.name}`, () => {
      expect(Uri.from(c.components).toString()).toBe(c.stringForm)
      if (c.skipEncodingForm !== undefined) {
        expect(Uri.from(c.components).toString(true)).toBe(c.skipEncodingForm)
      }
    })
  }

  for (const c of FORMAT_THROWS_URIERROR) {
    it(`throws URIError on ${c.name}`, () => {
      expect(() => Uri.from(c.components).toString()).toThrow(URIError)
    })
  }
})

describe('Uri — shared table: file()', () => {
  for (const c of FILE_CASES) {
    it(`normalizes ${c.name}`, () => {
      const uri = Uri.file(c.input)
      expect({ scheme: uri.scheme, authority: uri.authority, path: uri.path }).toEqual({
        scheme: 'file',
        authority: c.authority,
        path: c.path,
      })
      expect(uri.toString()).toBe(c.stringForm)
    })
  }
})

describe('Uri — shared table: joinPath()', () => {
  for (const c of JOIN_PATH_CASES) {
    it(`${c.name}`, () => {
      const joined = Uri.joinPath(Uri.parse(c.base), ...c.segments)
      expect(joined.path).toBe(c.path)
      if (c.authority !== undefined) expect(joined.authority).toBe(c.authority)
    })
  }
})

describe('Uri — shared table: fsPath (SDK policy)', () => {
  for (const c of FS_PATH_CASES) {
    it(`folds the drive letter and uses native separators on ${c.name}`, () => {
      expect(Uri.from(c.uri).fsPath).toBe(isWindows ? c.sdkWin32 : c.sdkPosix)
    })
  }
})

describe('Uri — SDK-only behaviour (divergences from the kernel)', () => {
  it('parse(value, true) throws on a missing or illegal scheme', () => {
    expect(() => Uri.parse('no scheme here', true)).toThrow()
    expect(() => Uri.parse('', true)).toThrow()
    expect(() => Uri.parse('https://example.com', true)).not.toThrow()
  })

  it('parse(value) without strict yields an empty Uri', () => {
    const uri = Uri.parse('no scheme here')
    expect(uri.scheme).toBe('')
    expect(uri.path).toBe('no scheme here')
  })

  it('from() requires a legal, non-empty scheme', () => {
    expect(() => Uri.from({ scheme: '1bad' })).toThrow(/scheme is missing or illegal/)
    expect(() => Uri.from({} as never)).toThrow(/scheme is missing or illegal/)
    expect(Uri.from({ scheme: 'file', path: '/c:/x' }).authority).toBe('')
  })

  it('joinPath() rejects a base without a path', () => {
    expect(() => Uri.joinPath(Uri.parse('https://example.com'), 'x')).toThrow(
      /cannot call joinPath on a URI without a path/,
    )
  })

  it('joinPath() always builds a new instance', () => {
    const uri = Uri.file('D:/foo')
    expect(Uri.joinPath(uri)).not.toBe(uri)
  })

  it('toJSON carries no `$mid` — the host boundary adds it', () => {
    expect(Uri.parse('https://ex.com/p?q=1#f').toJSON()).toEqual({
      scheme: 'https',
      authority: 'ex.com',
      path: '/p',
      query: 'q=1',
      fragment: 'f',
    })
  })

  it('has no revive / with / isUri surface', () => {
    expect('revive' in Uri).toBe(false)
    expect('isUri' in Uri).toBe(false)
    expect('with' in Uri.prototype).toBe(false)
  })
})
