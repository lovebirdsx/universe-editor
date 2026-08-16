/*---------------------------------------------------------------------------------------------
 *  Tests for packages/platform/src/remote/remoteProtocol.ts (WSL authority helpers).
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { URI } from '../../base/uri.js'
import {
  REMOTE_SCHEME,
  WSL_AUTHORITY_PREFIX,
  isValidWslDistroName,
  isWslAuthority,
  normalizeRemoteAuthority,
  remoteAuthorityLabel,
  wslAuthorityForDistro,
  wslDistroFromAuthority,
} from '../../remote/remoteProtocol.js'

describe('isValidWslDistroName', () => {
  it('accepts letters, digits, dot, underscore and dash', () => {
    expect(isValidWslDistroName('Ubuntu')).toBe(true)
    expect(isValidWslDistroName('Ubuntu-22.04')).toBe(true)
    expect(isValidWslDistroName('my_distro.v2')).toBe(true)
  })

  it('rejects empty, spaces, shell metacharacters and non-ascii', () => {
    expect(isValidWslDistroName('')).toBe(false)
    expect(isValidWslDistroName('my distro')).toBe(false)
    expect(isValidWslDistroName('a;b')).toBe(false)
    expect(isValidWslDistroName('a$(x)')).toBe(false)
    expect(isValidWslDistroName('发行版')).toBe(false)
  })
})

describe('wsl authority helpers', () => {
  it('round-trips distro → authority → distro', () => {
    const authority = wslAuthorityForDistro('Ubuntu-22.04')
    expect(authority).toBe(`${WSL_AUTHORITY_PREFIX}ubuntu-22.04`)
    expect(isWslAuthority(authority)).toBe(true)
    expect(wslDistroFromAuthority(authority)).toBe('ubuntu-22.04')
  })

  it('wslAuthorityForDistro produces a lowercase canonical distro', () => {
    expect(wslAuthorityForDistro('Ubuntu-24.04')).toBe('wsl+ubuntu-24.04')
    expect(wslAuthorityForDistro('Debian')).toBe('wsl+debian')
    expect(wslAuthorityForDistro('my_Distro.v2')).toBe('wsl+my_distro.v2')
  })

  it('isWslAuthority is false for ssh-style authorities', () => {
    expect(isWslAuthority('user@host:22')).toBe(false)
    expect(isWslAuthority('wslhost')).toBe(false)
  })

  it('wslAuthorityForDistro throws on an invalid distro name', () => {
    expect(() => wslAuthorityForDistro('bad name')).toThrow(/invalid WSL distro name/)
  })

  it('wslDistroFromAuthority throws on non-wsl or malformed authorities', () => {
    expect(() => wslDistroFromAuthority('user@host')).toThrow(/not a WSL authority/)
    expect(() => wslDistroFromAuthority('wsl+')).toThrow(/invalid WSL authority/)
    expect(() => wslDistroFromAuthority('wsl+bad name')).toThrow(/invalid WSL authority/)
  })
})

describe('normalizeRemoteAuthority', () => {
  it('folds WSL authority distro case to lowercase', () => {
    expect(normalizeRemoteAuthority('wsl+Ubuntu-24.04')).toBe('wsl+ubuntu-24.04')
    expect(normalizeRemoteAuthority('wsl+Debian')).toBe('wsl+debian')
    expect(normalizeRemoteAuthority('wsl+UBUNTU')).toBe('wsl+ubuntu')
  })

  it('returns an already-canonical WSL authority unchanged', () => {
    expect(normalizeRemoteAuthority('wsl+ubuntu')).toBe('wsl+ubuntu')
  })

  it('returns non-WSL authorities verbatim (ssh host aliases are case-sensitive)', () => {
    expect(normalizeRemoteAuthority('user@Host:22')).toBe('user@Host:22')
    expect(normalizeRemoteAuthority('Alice@ProdServer')).toBe('Alice@ProdServer')
    expect(normalizeRemoteAuthority('host')).toBe('host')
  })

  it('returns invalid inputs verbatim', () => {
    expect(normalizeRemoteAuthority('')).toBe('')
    expect(normalizeRemoteAuthority('wsl+')).toBe('wsl+')
    expect(normalizeRemoteAuthority('wsl+bad name')).toBe('wsl+bad name')
  })
})

describe('remoteAuthorityLabel', () => {
  it('labels a valid WSL authority with its distro', () => {
    expect(remoteAuthorityLabel('wsl+ubuntu-24.04')).toBe('WSL: ubuntu-24.04')
    expect(remoteAuthorityLabel('wsl+debian')).toBe('WSL: debian')
  })

  it('labels ssh-style authorities with the SSH prefix', () => {
    expect(remoteAuthorityLabel('myhost')).toBe('SSH: myhost')
    expect(remoteAuthorityLabel('user@host:2222')).toBe('SSH: user@host:2222')
  })

  it('falls back to SSH for a malformed WSL authority', () => {
    expect(remoteAuthorityLabel('wsl+')).toBe('SSH: wsl+')
    expect(remoteAuthorityLabel('wsl+bad name')).toBe('SSH: wsl+bad name')
  })
})

describe('wsl authority inside remote URIs', () => {
  it('survives a URI.from → toString → parse round-trip with case preserved', () => {
    const uri = URI.from({ scheme: REMOTE_SCHEME, authority: 'wsl+Ubuntu', path: '/home/x' })
    const reparsed = URI.parse(uri.toString())
    expect(reparsed.scheme).toBe(REMOTE_SCHEME)
    expect(reparsed.authority).toBe('wsl+Ubuntu')
    expect(reparsed.path).toBe('/home/x')
    expect(wslDistroFromAuthority(reparsed.authority)).toBe('Ubuntu')
  })
})
