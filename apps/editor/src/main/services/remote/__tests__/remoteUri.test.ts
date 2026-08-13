import { describe, expect, it } from 'vitest'
import { URI } from '@universe-editor/platform'
import { fromWire, remoteFsPathToUri, toWire } from '../remoteUri.js'

function remote(authority: string, path: string): URI {
  return URI.from({ scheme: 'remote-ssh', authority, path })
}

describe('remoteUri.toWire', () => {
  it('translates a posix remote path to a file URI keeping the path', () => {
    const wire = toWire(remote('host', '/home/user/file.txt'))
    expect(wire.scheme).toBe('file')
    expect(wire.path).toBe('/home/user/file.txt')
    expect(wire.toString()).toBe('file:///home/user/file.txt')
  })

  it('preserves a windows drive path (`/C:/…`)', () => {
    const wire = toWire(remote('host', '/C:/foo/bar.txt'))
    expect(wire.scheme).toBe('file')
    expect(wire.path).toBe('/C:/foo/bar.txt')
  })

  it('preserves spaces and special characters in the path', () => {
    const wire = toWire(remote('host', '/home/user/my dir/file name (1).txt'))
    expect(wire.path).toBe('/home/user/my dir/file name (1).txt')
  })

  it('rejects a non-remote scheme', () => {
    expect(() => toWire(URI.file('/home/user'))).toThrow(/remote-ssh/)
  })
})

describe('remoteUri.fromWire', () => {
  it('reattaches the authority to a posix file path', () => {
    const uri = fromWire(URI.file('/home/user/file.txt'), 'host')
    expect(uri.scheme).toBe('remote-ssh')
    expect(uri.authority).toBe('host')
    expect(uri.path).toBe('/home/user/file.txt')
  })

  it('reattaches the authority to a windows drive path', () => {
    const uri = fromWire(URI.file('C:/foo/bar.txt'), 'host')
    expect(uri.scheme).toBe('remote-ssh')
    expect(uri.authority).toBe('host')
    expect(uri.path).toBe('/C:/foo/bar.txt')
  })

  it('round-trips through toWire', () => {
    const original = remote('host', '/home/user/a b/c d.txt')
    expect(fromWire(toWire(original), 'host').toString()).toBe(original.toString())
  })

  it('rejects a non-file wire URI', () => {
    expect(() => fromWire(remote('other', '/x'), 'host')).toThrow(/file/)
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
})
