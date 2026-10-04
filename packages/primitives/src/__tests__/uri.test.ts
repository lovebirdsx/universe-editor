/**
 * The shared behaviour table, driven through this package's own functions. The
 * same table runs against `URI` and `Uri` in their own packages, so a change
 * here that only one side honours fails there too.
 */
import { describe, expect, it } from 'vitest'
import {
  FILE_CASES,
  FORMAT_CASES,
  FORMAT_THROWS_URIERROR,
  FS_PATH_CASES,
  JOIN_PATH_CASES,
  PARSE_CASES,
} from '../testing/uriCases.js'
import {
  decodeURIComponentSafe,
  encodeURIComponentFast,
  formatUri,
  isLegalScheme,
  joinUriPath,
  normalizeFileUriPath,
  parseUriComponents,
  uriToFsPath,
} from '../uri.js'

describe('parseUriComponents', () => {
  for (const c of PARSE_CASES) {
    it(`parses ${c.name}`, () => {
      const parsed = parseUriComponents(c.parse)
      expect(parsed, `no match for ${JSON.stringify(c.parse)}`).toBeDefined()
      expect({
        scheme: parsed!.scheme,
        authority: parsed!.authority,
        path: parsed!.path,
        query: parsed!.query,
        fragment: parsed!.fragment,
      }).toEqual({
        scheme: c.scheme,
        authority: c.authority,
        path: c.path,
        query: c.query,
        fragment: c.fragment,
      })
      if (c.stringForm !== undefined) {
        expect(formatUri(parsed!, encodeURIComponentFast)).toBe(c.stringForm)
      }
    })
  }
})

describe('formatUri', () => {
  for (const c of FORMAT_CASES) {
    it(`formats ${c.name}`, () => {
      expect(formatUri(c.components, encodeURIComponentFast)).toBe(c.stringForm)
    })
  }

  for (const c of FORMAT_THROWS_URIERROR) {
    it(`throws URIError on ${c.name}`, () => {
      expect(() => formatUri(c.components, encodeURIComponentFast)).toThrow(URIError)
    })
  }
})

describe('normalizeFileUriPath', () => {
  for (const c of FILE_CASES) {
    it(`normalizes ${c.name}`, () => {
      const normalized = normalizeFileUriPath(c.input)
      expect(normalized).toEqual({ authority: c.authority, path: c.path })
      expect(formatUri({ scheme: 'file', ...normalized }, encodeURIComponentFast)).toBe(
        c.stringForm,
      )
    })
  }
})

describe('joinUriPath', () => {
  for (const c of JOIN_PATH_CASES) {
    it(`${c.name}`, () => {
      const base = parseUriComponents(c.base)!
      const joined = joinUriPath(base.path, c.segments)
      expect(joined).toBe(c.path)
      if (c.authority !== undefined) expect(base.authority).toBe(c.authority)
    })
  }
})

describe('uriToFsPath', () => {
  for (const c of FS_PATH_CASES) {
    it(`matches both callers' policy on ${c.name}`, () => {
      expect(uriToFsPath(c.uri, { nativeSeparators: false, lowercaseDriveLetter: false })).toBe(
        c.kernel,
      )
      expect(uriToFsPath(c.uri, { nativeSeparators: false, lowercaseDriveLetter: true })).toBe(
        c.sdkPosix,
      )
      expect(uriToFsPath(c.uri, { nativeSeparators: true, lowercaseDriveLetter: true })).toBe(
        c.sdkWin32,
      )
    })
  }
})

describe('isLegalScheme', () => {
  it('accepts a single letter and the usual productions', () => {
    expect(isLegalScheme('file')).toBe(true)
    expect(isLegalScheme('remote-ssh')).toBe(true)
    expect(isLegalScheme('universe-editor')).toBe(true)
    expect(isLegalScheme('a+1.2-3')).toBe(true)
    expect(isLegalScheme('A')).toBe(true)
  })

  it('rejects empty, digit-leading and punctuated schemes', () => {
    expect(isLegalScheme('')).toBe(false)
    expect(isLegalScheme('1bad')).toBe(false)
    expect(isLegalScheme('!bad')).toBe(false)
    expect(isLegalScheme('has space')).toBe(false)
    expect(isLegalScheme('has/slash')).toBe(false)
  })
})

describe('decodeURIComponentSafe', () => {
  it('leaves values without a percent escape untouched', () => {
    expect(decodeURIComponentSafe('')).toBe('')
    expect(decodeURIComponentSafe('wsl+ubuntu2004')).toBe('wsl+ubuntu2004')
  })

  it('decodes a well-formed escape', () => {
    expect(decodeURIComponentSafe('wsl%2Bubuntu2004')).toBe('wsl+ubuntu2004')
    expect(decodeURIComponentSafe('%F0%9F%8E%89')).toBe('🎉')
  })

  it('returns a malformed value instead of throwing', () => {
    expect(decodeURIComponentSafe('wsl%2')).toBe('wsl%2')
    expect(decodeURIComponentSafe('%ZZ')).toBe('%ZZ')
  })
})
