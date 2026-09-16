import { describe, expect, it } from 'vitest'
import { URI } from '@universe-editor/platform'
import {
  canonicalizeWorkspaceFolderUri,
  remoteFsPathToUri,
  remotePathFromUri,
} from '../remoteUri.js'

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

describe('remoteUri.canonicalizeWorkspaceFolderUri', () => {
  it('folds a local folder drive letter so one folder has one identity', () => {
    // The workspace bucket id is a hash of this string — two spellings would mean
    // two storage files, two windows and a recent list holding the folder twice.
    expect(canonicalizeWorkspaceFolderUri(URI.file('e:/ws')).toString()).toBe('file:///E:/ws')
    expect(canonicalizeWorkspaceFolderUri(URI.file('E:/ws')).toString()).toBe(
      canonicalizeWorkspaceFolderUri(URI.file('e:/ws')).toString(),
    )
  })

  it('still folds the WSL distro case of a remote folder', () => {
    const uri = canonicalizeWorkspaceFolderUri(remote('wsl+Ubuntu-24.04', '/home/u/proj'))
    expect(uri.authority).toBe('wsl+ubuntu-24.04')
    expect(uri.path).toBe('/home/u/proj')
  })

  it('leaves a posix folder and a non-WSL remote folder untouched', () => {
    const posix = URI.file('/home/u/proj')
    expect(canonicalizeWorkspaceFolderUri(posix)).toBe(posix)
    const host = remote('user@Host:22', '/home/u/proj')
    expect(canonicalizeWorkspaceFolderUri(host)).toBe(host)
  })
})
