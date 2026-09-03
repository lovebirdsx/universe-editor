import { describe, expect, it } from 'vitest'
import {
  clientToLocalPath,
  collapseScopeDirs,
  containsAny,
  isUnderAny,
  norm,
  scopeKey,
  uriToFsPath,
} from '../pathUtil.js'

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

describe('isUnderAny', () => {
  it('matches a file under one of the dirs', () => {
    expect(isUnderAny('C:/ws/Client/a.txt', ['C:/ws/Client'])).toBe(true)
    expect(isUnderAny('C:/ws/Client', ['C:/ws/Client'])).toBe(true)
  })

  it('matches under any dir, not just the first', () => {
    expect(isUnderAny('C:/ws/Other/x.txt', ['C:/ws/A', 'C:/ws/Other'])).toBe(true)
  })

  it('never matches on a bare prefix (Client must not match ClientTools)', () => {
    expect(isUnderAny('C:/ws/ClientTools/a.txt', ['C:/ws/Client'])).toBe(false)
    expect(isUnderAny('C:/ws/Client/a.txt', ['C:/ws/ClientTools'])).toBe(false)
  })

  it('is drive-letter case-insensitive and slash-insensitive', () => {
    expect(isUnderAny('c:/ws/Client/a.txt', ['C:\\ws\\Client'])).toBe(true)
  })

  it('matches nothing for an empty dir list', () => {
    expect(isUnderAny('C:/ws/a.txt', [])).toBe(false)
  })

  it('does not match a sibling directory that only shares a prefix', () => {
    expect(isUnderAny('C:/ws/AB', ['C:/ws/A'])).toBe(false)
    expect(isUnderAny('C:/ws/A', ['C:/ws/AB'])).toBe(false)
  })

  it('follows the host case policy for the path segments too', () => {
    // Focus folders are typed by a human, the compared path comes from p4 or
    // the OS — on win32/darwin their case will not match.
    const insensitive = process.platform === 'win32' || process.platform === 'darwin'
    expect(isUnderAny('C:/ws/Client/a.txt', ['C:/ws/client'])).toBe(insensitive)
    expect(isUnderAny('C:/ws/CLIENT', ['C:/ws/client'])).toBe(insensitive)
    // Case folding must not defeat the directory boundary.
    expect(isUnderAny('C:/ws/clientTools/a.txt', ['C:/ws/Client'])).toBe(false)
  })
})

describe('scopeKey', () => {
  it('folds the whole path on a case-insensitive host, drive letter only elsewhere', () => {
    if (process.platform === 'win32' || process.platform === 'darwin') {
      expect(scopeKey('C:\\ws\\Client\\')).toBe('c:/ws/client')
    } else {
      expect(scopeKey('/ws/Client/')).toBe('/ws/Client')
    }
  })
})

describe('containsAny', () => {
  it('matches a child directory inside parentDir', () => {
    expect(containsAny('C:/ws/Client', ['C:/ws/Client/Sub'])).toBe(true)
    expect(containsAny('C:/ws/Client', ['C:/ws/Client/Sub/Deep/x.txt'])).toBe(true)
  })

  it('matches a dir equal to parentDir (callers must test parentDir exclusion first)', () => {
    expect(containsAny('C:/ws/Client', ['C:/ws/Client'])).toBe(true)
  })

  it('matches when any of the dirs is contained, not just the first', () => {
    expect(containsAny('C:/ws/A', ['C:/ws/Elsewhere', 'C:/ws/A/B'])).toBe(true)
  })

  it('matches nothing for an empty dir list', () => {
    expect(containsAny('C:/ws/a', [])).toBe(false)
  })

  it('never matches on a bare prefix (A does not contain AB)', () => {
    expect(containsAny('C:/ws/A', ['C:/ws/AB'])).toBe(false)
    expect(containsAny('C:/ws/A', ['C:/ws/AB/x.txt'])).toBe(false)
  })

  it('follows the host case policy like isUnderAny', () => {
    const insensitive = process.platform === 'win32' || process.platform === 'darwin'
    expect(containsAny('C:/ws/Client', ['C:/ws/client/sub'])).toBe(insensitive)
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
        '//ws/src/client/scripts/src/editor/common/Scheme/Component/ElementalComponent.ts',
        'G:/p4ws/main',
      ),
    ).toBe(
      'G:/p4ws/main/src/client/scripts/src/editor/common/Scheme/Component/ElementalComponent.ts',
    )
  })

  it('normalizes a backslash client root and drops a trailing slash', () => {
    expect(clientToLocalPath('//ws/a/b.ts', 'G:\\p4ws\\main\\')).toBe('G:/p4ws/main/a/b.ts')
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

describe('collapseScopeDirs', () => {
  it('dedupes and strips trailing slashes', () => {
    expect(collapseScopeDirs(['C:/ws/A/', 'C:/ws/A'])).toEqual(['C:/ws/A'])
  })

  it('collapses nested child to shallowest ancestor', () => {
    expect(collapseScopeDirs(['C:/ws/A', 'C:/ws/A/B', 'C:/ws/C'])).toEqual(['C:/ws/A', 'C:/ws/C'])
  })

  it('keeps sibling directories that only share a prefix', () => {
    expect(collapseScopeDirs(['C:/ws/A', 'C:/ws/AB'])).toEqual(['C:/ws/A', 'C:/ws/AB'])
  })
})
