/*---------------------------------------------------------------------------------------------
 *  Tests for scmHostPath — host-scoped resolution of a resource to the bare
 *  fs-path the SCM wire contract keys on.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { REMOTE_SCHEME, URI } from '@universe-editor/platform'
import { scmHostPath } from '../scmHostPath.js'

/** `remote-ssh://<authority>/<path>` (path carries the canonical leading slash). */
function remote(authority: string, path: string): URI {
  return URI.from({ scheme: REMOTE_SCHEME, authority, path })
}

describe('scmHostPath', () => {
  describe('local window (no remote authority)', () => {
    it('resolves a file: resource to its native path', () => {
      expect(scmHostPath(URI.file('D:/repo/a.ts'), undefined)).toBe('D:/repo/a.ts')
    })

    it('rejects a remote resource', () => {
      expect(scmHostPath(remote('myhost', '/home/u/repo/a.ts'), undefined)).toBeUndefined()
    })

    it('rejects a virtual scheme', () => {
      expect(scmHostPath(URI.parse('markdown-preview://x/a.md'), undefined)).toBeUndefined()
    })
  })

  describe('remote window', () => {
    it('resolves a POSIX remote resource on the same authority', () => {
      expect(scmHostPath(remote('myhost', '/home/u/repo/a.ts'), 'myhost')).toBe('/home/u/repo/a.ts')
    })

    it('strips the leading slash of a Windows remote drive path', () => {
      expect(scmHostPath(remote('winhost', '/C:/repo/a.ts'), 'winhost')).toBe('C:/repo/a.ts')
    })

    it('rejects a resource on another authority', () => {
      expect(scmHostPath(remote('otherhost', '/home/u/repo/a.ts'), 'myhost')).toBeUndefined()
    })

    it('rejects a client-local file: resource opened in a remote window', () => {
      // Guards the cross-host collision: a Windows remote's C:\repo\a.ts and the
      // client's own C:\repo\a.ts are different files with the same fsPath.
      expect(scmHostPath(URI.file('C:/repo/a.ts'), 'winhost')).toBeUndefined()
    })

    it('matches a WSL authority case-insensitively on both sides', () => {
      expect(scmHostPath(remote('wsl+Ubuntu', '/home/u/repo/a.ts'), 'wsl+ubuntu')).toBe(
        '/home/u/repo/a.ts',
      )
      expect(scmHostPath(remote('wsl+ubuntu', '/home/u/repo/a.ts'), 'wsl+Ubuntu')).toBe(
        '/home/u/repo/a.ts',
      )
    })

    it('keeps ssh host aliases case-sensitive', () => {
      expect(scmHostPath(remote('MyHost', '/home/u/repo/a.ts'), 'myhost')).toBeUndefined()
    })

    it('rejects a remote resource with no authority', () => {
      expect(
        scmHostPath(URI.from({ scheme: REMOTE_SCHEME, path: '/home/u/a.ts' }), 'myhost'),
      ).toBeUndefined()
    })

    it('rejects virtual schemes (diff / untitled / preview)', () => {
      for (const uri of [
        URI.parse('untitled:Untitled-1'),
        URI.parse('dirtydiff-peek://original/1'),
        URI.parse('markdown-preview://x/a.md'),
      ]) {
        expect(scmHostPath(uri, 'myhost')).toBeUndefined()
      }
    })
  })
})
