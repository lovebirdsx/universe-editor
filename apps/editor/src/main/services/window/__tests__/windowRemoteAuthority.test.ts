/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/services/window/windowRemoteAuthority.ts
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { URI } from '@universe-editor/platform'
import { deriveWindowRemoteAuthority } from '../windowRemoteAuthority.js'

const remote = (authority: string): URI => URI.parse(`remote-ssh://${authority}/home/u`)

describe('deriveWindowRemoteAuthority', () => {
  it('derives the authority from a remote workspace folder', () => {
    expect(deriveWindowRemoteAuthority(remote('myhost'), undefined)).toBe('myhost')
  })

  it('falls back to the option authority for an empty window', () => {
    expect(deriveWindowRemoteAuthority(undefined, 'myhost')).toBe('myhost')
  })

  it('returns undefined when neither a remote folder nor an option is given', () => {
    expect(deriveWindowRemoteAuthority(undefined, undefined)).toBeUndefined()
  })

  it('a local workspace folder wins and suppresses the option authority', () => {
    expect(deriveWindowRemoteAuthority(URI.file('/tmp/proj'), 'myhost')).toBeUndefined()
  })

  it('normalizes WSL authority case', () => {
    expect(deriveWindowRemoteAuthority(remote('wsl+Ubuntu'), undefined)).toBe('wsl+ubuntu')
    expect(deriveWindowRemoteAuthority(undefined, 'wsl+Ubuntu')).toBe('wsl+ubuntu')
  })

  it('leaves non-WSL ssh authorities verbatim', () => {
    expect(deriveWindowRemoteAuthority(remote('MyHost.Alias'), undefined)).toBe('MyHost.Alias')
  })
})
