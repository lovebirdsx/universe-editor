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
    expect(authority).toBe(`${WSL_AUTHORITY_PREFIX}Ubuntu-22.04`)
    expect(isWslAuthority(authority)).toBe(true)
    expect(wslDistroFromAuthority(authority)).toBe('Ubuntu-22.04')
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
