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

  it('relativePath computes the URI-level tail under a folder', () => {
    const svc = new UriIdentityService('win32')
    expect(svc.relativePath(URI.file('D:/Proj'), URI.file('d:/proj/Src/Foo.ts'))).toBe('Src/Foo.ts')
    expect(svc.relativePath(URI.file('D:/Proj'), URI.file('D:/Proj'))).toBe('')
    expect(svc.relativePath(URI.file('D:/Proj'), URI.file('d:/other'))).toBeNull()
  })

  it('relativePath requires matching scheme and authority', () => {
    const svc = new UriIdentityService('linux')
    const remote = URI.from({ scheme: 'remote-ssh', authority: 'host', path: '/home/u/proj' })
    expect(
      svc.relativePath(remote, URI.from({ scheme: 'file', path: '/home/u/proj/src/a.ts' })),
    ).toBeNull()
    expect(
      svc.relativePath(
        remote,
        URI.from({ scheme: 'remote-ssh', authority: 'other', path: '/home/u/proj/src/a.ts' }),
      ),
    ).toBeNull()
    expect(
      svc.relativePath(
        remote,
        URI.from({ scheme: 'remote-ssh', authority: 'host', path: '/home/u/proj/src/a.ts' }),
      ),
    ).toBe('src/a.ts')
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

describe('UriIdentityService per-scheme case sensitivity', () => {
  const remoteFoo = URI.from({ scheme: 'remote-ssh', authority: 'host', path: '/src/Foo.ts' })
  const remoteFooLower = URI.from({ scheme: 'remote-ssh', authority: 'host', path: '/src/foo.ts' })

  it('defaults to the host platform for an unregistered scheme', () => {
    const svc = new UriIdentityService('win32')
    expect(svc.isCaseSensitive(remoteFoo)).toBe(false)
    expect(svc.isEqual(remoteFoo, remoteFooLower)).toBe(true)
  })

  it('keeps a Linux remote case-sensitive even when the UI runs on Windows', () => {
    const svc = new UriIdentityService('win32')
    svc.registerSchemeCaseSensitivity('remote-ssh', true)

    expect(svc.isCaseSensitive(remoteFoo)).toBe(true)
    expect(svc.isEqual(remoteFoo, remoteFooLower)).toBe(false)
    expect(svc.getComparisonKey(remoteFoo)).not.toBe(svc.getComparisonKey(remoteFooLower))
    expect(svc.isEqualOrParent(remoteFoo, URI.from({ ...remoteFoo, path: '/SRC' }))).toBe(false)
    expect(svc.isEqualOrParent(remoteFoo, URI.from({ ...remoteFoo, path: '/src' }))).toBe(true)
  })

  it('leaves the local file: scheme on the host-platform policy', () => {
    const svc = new UriIdentityService('win32')
    svc.registerSchemeCaseSensitivity('remote-ssh', true)

    expect(svc.isCaseSensitive(URI.file('D:/x/Foo.ts'))).toBe(false)
    expect(svc.isEqual(URI.file('D:/x/Foo.ts'), URI.file('d:/x/foo.ts'))).toBe(true)
  })

  it('lets a case-insensitive provider fold case on a case-sensitive host', () => {
    const svc = new UriIdentityService('linux')
    svc.registerSchemeCaseSensitivity('remote-ssh', false)
    expect(svc.isEqual(remoteFoo, remoteFooLower)).toBe(true)
  })

  it('resource maps and sets follow the registered policy', () => {
    const svc = new UriIdentityService('win32')
    svc.registerSchemeCaseSensitivity('remote-ssh', true)

    const map = svc.createResourceMap<number>()
    map.set(remoteFoo, 1)
    expect(map.get(remoteFooLower)).toBeUndefined()
    expect(map.get(remoteFoo)).toBe(1)
  })

  it('disposing restores the host-platform default', () => {
    const svc = new UriIdentityService('win32')
    const handle = svc.registerSchemeCaseSensitivity('remote-ssh', true)

    handle.dispose()
    expect(svc.isCaseSensitive(remoteFoo)).toBe(false)
    expect(svc.isEqual(remoteFoo, remoteFooLower)).toBe(true)
  })

  it('a stale disposable does not clear a re-registered policy', () => {
    const svc = new UriIdentityService('win32')
    const stale = svc.registerSchemeCaseSensitivity('remote-ssh', true)
    stale.dispose()

    svc.registerSchemeCaseSensitivity('remote-ssh', false)
    stale.dispose()
    expect(svc.isCaseSensitive(remoteFoo)).toBe(false)
  })

  it('string-path helpers stay platform-bound — raw paths carry no scheme', () => {
    const svc = new UriIdentityService('win32')
    svc.registerSchemeCaseSensitivity('remote-ssh', true)
    expect(svc.arePathsEqual('/src/Foo.ts', '/src/foo.ts')).toBe(true)
  })

  it('relativePath honours the registered remote case policy', () => {
    const folder = URI.from({ scheme: 'remote-ssh', authority: 'host', path: '/home/u/proj' })
    const upperFile = URI.from({
      scheme: 'remote-ssh',
      authority: 'host',
      path: '/HOME/U/PROJ/src/a.ts',
    })

    const ci = new UriIdentityService('win32')
    expect(ci.relativePath(folder, upperFile)).toBe('src/a.ts')

    const cs = new UriIdentityService('win32')
    cs.registerSchemeCaseSensitivity('remote-ssh', true)
    expect(cs.relativePath(folder, upperFile)).toBeNull()
  })
})
