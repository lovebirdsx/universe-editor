import { describe, expect, it } from 'vitest'
import { URI } from '../../base/uri.js'
import {
  fsPathToWorkspaceUri,
  localRevealFsPath,
  remoteFsPathToUri,
  remotePathFromUri,
  wslUncPath,
} from '../../remote/remoteUri.js'

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

describe('remoteUri.fsPathToWorkspaceUri', () => {
  it('builds a remote-ssh URI when an authority is given', () => {
    const uri = fsPathToWorkspaceUri('/home/user/file.txt', 'ssh-remote+host')
    expect(uri.scheme).toBe('remote-ssh')
    expect(uri.authority).toBe('ssh-remote+host')
    expect(uri.path).toBe('/home/user/file.txt')
  })

  it('builds a file URI when the authority is undefined (local workspace)', () => {
    const uri = fsPathToWorkspaceUri('C:\\ws\\repo\\a.ts', undefined)
    expect(uri.scheme).toBe('file')
    expect(uri.fsPath.toLowerCase()).toBe('c:/ws/repo/a.ts')
  })
})

describe('remoteUri.wslUncPath', () => {
  it('builds the wsl$ UNC path, converting separators and preserving spaces', () => {
    expect(wslUncPath('wsl+ubuntu-24.04', '/home/x/a b/c.txt')).toBe(
      '\\\\wsl$\\ubuntu-24.04\\home\\x\\a b\\c.txt',
    )
  })

  it('canonicalizes a mixed-case distro to lowercase', () => {
    expect(wslUncPath('wsl+Ubuntu-24.04', '/home/x')).toBe('\\\\wsl$\\ubuntu-24.04\\home\\x')
  })

  it('returns undefined for a non-WSL authority', () => {
    expect(wslUncPath('user@host:22', '/home/x')).toBeUndefined()
    expect(wslUncPath('ssh-remote+host', '/home/x')).toBeUndefined()
  })

  it('returns undefined for a relative (non-absolute) path', () => {
    expect(wslUncPath('wsl+ubuntu', 'home/x')).toBeUndefined()
  })

  it('returns undefined for a malformed WSL authority (port / empty distro)', () => {
    expect(wslUncPath('wsl+ubuntu:22', '/home/x')).toBeUndefined()
    expect(wslUncPath('wsl+', '/home/x')).toBeUndefined()
  })
})

describe('remoteUri.localRevealFsPath', () => {
  it('returns the fsPath for a file URI regardless of isWindows', () => {
    expect(localRevealFsPath(URI.file('/home/user/file.txt'), { isWindows: true })).toBe(
      '/home/user/file.txt',
    )
    expect(localRevealFsPath(URI.file('/home/user/file.txt'), { isWindows: false })).toBe(
      '/home/user/file.txt',
    )
  })

  it('maps a WSL remote to its wsl$ UNC path on Windows', () => {
    expect(
      localRevealFsPath(remote('wsl+ubuntu-24.04', '/home/x/a b/c.txt'), { isWindows: true }),
    ).toBe('\\\\wsl$\\ubuntu-24.04\\home\\x\\a b\\c.txt')
  })

  it('returns undefined for a WSL remote on a non-Windows client', () => {
    expect(localRevealFsPath(remote('wsl+ubuntu', '/home/x'), { isWindows: false })).toBeUndefined()
  })

  it('returns undefined for a non-WSL remote', () => {
    expect(localRevealFsPath(remote('user@host', '/home/x'), { isWindows: true })).toBeUndefined()
  })
})
