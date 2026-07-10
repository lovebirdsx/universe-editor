import { describe, expect, it } from 'vitest'
import { norm, uriToFsPath } from '../pathUtil.js'

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
