import { describe, expect, it } from 'vitest'
import { URI } from '@universe-editor/platform'
import { remoteFsPathToUri, remotePathFromUri } from '../remoteUri.js'

function remote(authority: string, path: string): URI {
  return URI.from({ scheme: 'remote-ssh', authority, path })
}

describe('remoteUri.remotePathFromUri', () => {
  it('returns the server-local path (uri.path) for a posix remote path', () => {
    expect(remotePathFromUri(remote('host', '/home/user/file.txt'))).toBe('/home/user/file.txt')
  })

  it('returns the path untouched for spaces and special characters', () => {
    expect(remotePathFromUri(remote('host', '/home/user/my dir/file name (1).txt'))).toBe(
      '/home/user/my dir/file name (1).txt',
    )
  })

  it('rejects a non-remote scheme', () => {
    expect(() => remotePathFromUri(URI.file('/home/user'))).toThrow(/remote-ssh/)
  })

  it('strips the leading slash from a windows drive-letter path', () => {
    expect(remotePathFromUri(remote('host', '/C:/Users/me/file.txt'))).toBe('C:/Users/me/file.txt')
  })
})

describe('remoteUri.remoteFsPathToUri', () => {
  it('maps a posix absolute path', () => {
    const uri = remoteFsPathToUri('/home/user/file.txt', 'host')
    expect(uri.scheme).toBe('remote-ssh')
    expect(uri.authority).toBe('host')
    expect(uri.path).toBe('/home/user/file.txt')
  })

  it('normalises backslashes and adds a leading slash for a windows path', () => {
    const uri = remoteFsPathToUri('C:\\home\\user\\file.txt', 'host')
    expect(uri.path).toBe('/C:/home/user/file.txt')
  })

  it('normalises a forward-slash windows path', () => {
    const uri = remoteFsPathToUri('C:/home/user/file.txt', 'host')
    expect(uri.path).toBe('/C:/home/user/file.txt')
  })

  it('round-trips with remotePathFromUri for posix paths', () => {
    const original = remote('host', '/home/user/a b/c d.txt')
    expect(remotePathFromUri(remoteFsPathToUri(remotePathFromUri(original), 'host'))).toBe(
      original.path,
    )
  })
})
