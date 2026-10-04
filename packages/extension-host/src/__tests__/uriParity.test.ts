/**
 * The kernel's `URI` and the extension SDK's `Uri` are two deliberately different
 * surfaces over one shared core. This suite runs a single table through both and
 * asserts they agree on everything a value crossing the RPC boundary depends on —
 * `parse` components, `file()` normalization, `joinPath` results, `toString`
 * output — while pinning the four places they are *meant* to disagree.
 *
 * It lives here because extension-host is where the two worlds meet (`wireUri.ts`),
 * and because its `test` task builds both packages first, so this exercises the
 * published dist artifacts rather than their sources.
 */
import { Uri } from '@universe-editor/extension-api'
import { URI } from '@universe-editor/platform'
import {
  FILE_CASES,
  FORMAT_CASES,
  FS_PATH_CASES,
  JOIN_PATH_CASES,
  PARSE_CASES,
} from '@universe-editor/primitives/testing'
import { describe, expect, it } from 'vitest'
import { reviveWireUri } from '../wireUri.js'

const isWindows = process.platform === 'win32'

function componentsOf(uri: {
  scheme: string
  authority: string
  path: string
  query: string
  fragment: string
}) {
  return {
    scheme: uri.scheme,
    authority: uri.authority,
    path: uri.path,
    query: uri.query,
    fragment: uri.fragment,
  }
}

describe('URI / Uri parity: parse', () => {
  for (const c of PARSE_CASES) {
    it(`agrees on ${c.name}`, () => {
      const kernel = URI.parse(c.parse)
      const sdk = Uri.parse(c.parse)
      expect(componentsOf(sdk)).toEqual(componentsOf(kernel))
      expect(sdk.toString()).toBe(kernel.toString())
      if (c.stringForm !== undefined) expect(kernel.toString()).toBe(c.stringForm)
    })
  }
})

describe('URI / Uri parity: file()', () => {
  for (const c of FILE_CASES) {
    it(`agrees on ${c.name}`, () => {
      const kernel = URI.file(c.input)
      const sdk = Uri.file(c.input)
      expect({ authority: sdk.authority, path: sdk.path }).toEqual({
        authority: kernel.authority,
        path: kernel.path,
      })
      expect(sdk.toString()).toBe(kernel.toString())
    })
  }
})

describe('URI / Uri parity: joinPath()', () => {
  for (const c of JOIN_PATH_CASES) {
    it(`agrees on ${c.name}`, () => {
      const kernel = URI.joinPath(URI.parse(c.base), ...c.segments)
      const sdk = Uri.joinPath(Uri.parse(c.base), ...c.segments)
      expect(sdk.path).toBe(kernel.path)
      expect(sdk.authority).toBe(kernel.authority)
      expect(sdk.toString()).toBe(kernel.toString())
    })
  }
})

describe('URI / Uri parity: toString()', () => {
  for (const c of FORMAT_CASES) {
    it(`agrees on ${c.name}`, () => {
      expect(Uri.from(c.components).toString()).toBe(URI.from(c.components).toString())
    })
  }
})

describe('URI / Uri parity: the RPC boundary', () => {
  for (const c of FORMAT_CASES) {
    it(`re-encodes ${c.name} identically from the SDK's JSON form`, () => {
      const sdk = Uri.from(c.components)
      // An extension hands the host a plain components object (its toJSON has no
      // `$mid`), and the host rebuilds a kernel URI from it — same string, or one
      // file gets two identities across the boundary.
      expect(URI.from(sdk.toJSON()).toString()).toBe(sdk.toString())
    })
  }

  it('reviveWireUri puts an SDK URI back on the codec radar', () => {
    const sdk = Uri.parse('file:///D:/x/a.ts')
    const revived = reviveWireUri(sdk.toJSON())
    expect(revived).toBeInstanceOf(URI)
    expect(revived.toString()).toBe(sdk.toString())
    expect(revived.toJSON().$mid).toBe(1)
  })

  it('reviveWireUri passes a kernel URI through untouched', () => {
    const kernel = URI.parse('file:///D:/x/a.ts')
    expect(reviveWireUri(kernel)).toBe(kernel)
  })
})

describe('URI / Uri divergence: fsPath policy', () => {
  for (const c of FS_PATH_CASES) {
    it(`keeps each side's policy on ${c.name}`, () => {
      expect(URI.from(c.uri).fsPath).toBe(c.kernel)
      expect(Uri.from(c.uri).fsPath).toBe(isWindows ? c.sdkWin32 : c.sdkPosix)
    })
  }

  it('actually differs on a drive path: the kernel keeps the casing and separators', () => {
    const kernel = URI.file('D:/foo').fsPath
    const sdk = Uri.file('D:/foo').fsPath
    expect(kernel).toBe('D:/foo')
    expect(sdk).toBe(isWindows ? 'd:\\foo' : 'd:/foo')
    expect(sdk).not.toBe(kernel)
  })
})

describe('URI / Uri divergence: JSON and surface', () => {
  it('only the kernel marks toJSON with `$mid`', () => {
    const components = { scheme: 'file', path: '/D:/x' }
    expect(URI.from(components).toJSON()).toEqual({ $mid: 1, scheme: 'file', path: '/D:/x' })
    expect(Uri.from(components).toJSON()).toEqual({ scheme: 'file', path: '/D:/x' })
  })

  it('only the SDK takes a strict flag and a skipEncoding flag', () => {
    expect(() => Uri.parse('no scheme here', true)).toThrow()
    expect(URI.parse('no scheme here').scheme).toBe('')
    expect(Uri.parse('file:///a%20b').toString(true)).toBe('file:///a b')
    expect(URI.parse('file:///a%20b').toString()).toBe('file:///a%20b')
  })
})
