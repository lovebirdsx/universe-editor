import { describe, expect, it } from 'vitest'
import { clientToLocalPath, norm, uriToFsPath } from '../pathUtil.js'

describe('uriToFsPath', () => {
  it('strips the leading slash before a Windows drive letter', () => {
    expect(uriToFsPath({ scheme: 'file', path: '/D:/git/foo.txt' })).toBe('D:/git/foo.txt')
  })

  it('keeps a posix absolute path as-is', () => {
    expect(uriToFsPath({ scheme: 'file', path: '/home/alice/a.txt' })).toBe('/home/alice/a.txt')
  })

  it('decodes percent-encoded characters', () => {
    expect(uriToFsPath({ scheme: 'file', path: '/D:/a%20b/c.txt' })).toBe('D:/a b/c.txt')
  })

  it('returns undefined for non-file schemes', () => {
    expect(uriToFsPath({ scheme: 'untitled', path: '/foo' })).toBeUndefined()
    expect(uriToFsPath({ scheme: 'file' })).toBeUndefined()
  })
})

describe('norm', () => {
  it('lower-cases the drive letter and forward-slashes', () => {
    expect(norm('D:\\Git\\Foo')).toBe('d:/Git/Foo')
  })
})

describe('clientToLocalPath', () => {
  // Repro for "an edited file shows as a full delete + `//` URI error when opening
  // its diff": `p4 opened`/`reconcile -n` report `clientFile` in CLIENT SYNTAX
  // (`//clientName/rel`), not a local path. Feeding that to readFile / a file: URI
  // breaks. This must translate it to the on-disk path under the client root.
  it('rewrites a client-syntax path onto the client root', () => {
    expect(
      clientToLocalPath(
        '//aki_ws/Source/Client/TypeScript/Src/UniverseEditor/EditorCommon/Scheme/Component/ElementalComponent.ts',
        'G:/aki_3.6',
      ),
    ).toBe(
      'G:/aki_3.6/Source/Client/TypeScript/Src/UniverseEditor/EditorCommon/Scheme/Component/ElementalComponent.ts',
    )
  })

  it('normalizes a backslash client root and drops a trailing slash', () => {
    expect(clientToLocalPath('//ws/a/b.ts', 'G:\\aki_3.6\\')).toBe('G:/aki_3.6/a/b.ts')
  })

  it('handles a client name that itself contains characters', () => {
    expect(clientToLocalPath('//user-mac-ws/dir/file.txt', '/Users/u/ws')).toBe(
      '/Users/u/ws/dir/file.txt',
    )
  })

  it('leaves an already-local drive path untouched', () => {
    expect(clientToLocalPath('D:/work/a.txt', 'D:/work')).toBe('D:/work/a.txt')
  })

  it('leaves a posix-absolute local path untouched', () => {
    expect(clientToLocalPath('/home/u/ws/a.txt', '/home/u/ws')).toBe('/home/u/ws/a.txt')
  })

  it('returns the input unchanged for a degenerate client-only spec', () => {
    expect(clientToLocalPath('//ws', 'G:/root')).toBe('//ws')
  })
})
