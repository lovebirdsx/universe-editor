import { describe, expect, it } from 'vitest'
import { REMOTE_SCHEME, URI } from '@universe-editor/platform'
import { terminalPathToUri } from '../useTerminalOpenFile.js'

const remoteFolder = URI.parse('remote-ssh://myhost/home/u/proj')

describe('terminalPathToUri', () => {
  it('maps a POSIX path under a local file workspace to a file: URI', () => {
    const uri = terminalPathToUri('/repo/src/a.ts', URI.file('/repo'))
    expect(uri.scheme).toBe('file')
    expect(uri.fsPath).toBe('/repo/src/a.ts')
  })

  it('maps a Windows drive path under a local file workspace to a file: URI', () => {
    const uri = terminalPathToUri('D:/repo/a.ts', URI.file('/repo'))
    expect(uri.scheme).toBe('file')
    expect(uri.fsPath).toBe('D:/repo/a.ts')
  })

  it('inherits the remote folder scheme/authority for a POSIX path', () => {
    const uri = terminalPathToUri('/home/u/proj/src/a.ts', remoteFolder)
    expect(uri.scheme).toBe(REMOTE_SCHEME)
    expect(uri.authority).toBe('myhost')
    expect(uri.path).toBe('/home/u/proj/src/a.ts')
  })

  it('normalizes mixed backslashes under a remote folder', () => {
    const uri = terminalPathToUri('/home/u/proj\\src\\a.ts', remoteFolder)
    expect(uri.scheme).toBe(REMOTE_SCHEME)
    expect(uri.path).toBe('/home/u/proj/src/a.ts')
  })

  it('falls back to file: for a Windows drive path under a remote folder', () => {
    const uri = terminalPathToUri('D:/repo/a.ts', remoteFolder)
    expect(uri.scheme).toBe('file')
    expect(uri.fsPath).toBe('D:/repo/a.ts')
  })

  it('falls back to file: when no folder is given', () => {
    const uri = terminalPathToUri('/home/u/a.ts', undefined)
    expect(uri.scheme).toBe('file')
    expect(uri.fsPath).toBe('/home/u/a.ts')
  })
})
