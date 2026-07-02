/*---------------------------------------------------------------------------------------------
 *  Tests for packages/platform/src/uriIdentity/uriIdentityService.ts.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { URI } from '../../base/uri.js'
import { UriIdentityService } from '../../uriIdentity/uriIdentityService.js'

describe('UriIdentityService', () => {
  it('binds the platform so callers never pass it (win32 folds case)', () => {
    const svc = new UriIdentityService('win32')
    expect(svc.isEqual(URI.file('D:/x/Foo.ts'), URI.file('d:/X/foo.ts'))).toBe(true)
    expect(svc.arePathsEqual('D:\\x\\Foo.ts', 'd:/x/foo.ts')).toBe(true)
  })

  it('is case-sensitive on linux', () => {
    const svc = new UriIdentityService('linux')
    expect(svc.isEqual(URI.file('/x/Foo.ts'), URI.file('/x/foo.ts'))).toBe(false)
    expect(svc.arePathsEqual('/x/Foo.ts', '/x/foo.ts')).toBe(false)
  })

  it('isEqualOrParent respects segment boundaries', () => {
    const svc = new UriIdentityService('linux')
    expect(svc.isEqualOrParent(URI.file('/a/b/c'), URI.file('/a/b'))).toBe(true)
    expect(svc.isEqualOrParent(URI.file('/a/bc'), URI.file('/a/b'))).toBe(false)
  })

  it('relativePathUnder returns the tail preserving casing', () => {
    const svc = new UriIdentityService('win32')
    expect(svc.relativePathUnder('D:\\Proj', 'd:/proj/Src/Foo.ts')).toBe('Src/Foo.ts')
    expect(svc.relativePathUnder('D:\\Proj', 'd:/other')).toBeNull()
  })

  it('getPathComparisonKey keys string paths under the bound platform', () => {
    expect(new UriIdentityService('win32').getPathComparisonKey('D:\\x\\Foo.ts')).toBe(
      'd:/x/foo.ts',
    )
    expect(new UriIdentityService('linux').getPathComparisonKey('/x/Foo.ts')).toBe('/x/Foo.ts')
  })

  it('createResourceMap / createResourceSet use the bound key', () => {
    const svc = new UriIdentityService('win32')
    const map = svc.createResourceMap<number>()
    map.set(URI.file('D:/x/Foo.ts'), 1)
    expect(map.get(URI.file('d:/x/foo.ts'))).toBe(1)

    const set = svc.createResourceSet()
    set.add(URI.file('D:/x/Foo.ts'))
    expect(set.has(URI.file('d:/x/foo.ts'))).toBe(true)
  })
})
