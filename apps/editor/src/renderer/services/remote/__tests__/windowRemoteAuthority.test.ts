/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/renderer/services/remote/windowRemoteAuthority.ts
 *  renderer-node (no DOM): `window` is undefined by default, so the argv path is
 *  exercised by stubbing the global.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from 'vitest'
import { URI } from '@universe-editor/platform'
import {
  currentRemoteAuthority,
  remoteAuthorityFromWorkspace,
  windowArgvRemoteAuthority,
} from '../windowRemoteAuthority.js'

const remote = (authority: string): URI => URI.parse(`remote-ssh://${authority}/home/u`)

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('windowRemoteAuthority', () => {
  it('windowArgvRemoteAuthority returns undefined when window is undefined (node/test)', () => {
    expect(windowArgvRemoteAuthority()).toBeUndefined()
  })

  it('windowArgvRemoteAuthority reads and normalizes window.ipc.remoteAuthority', () => {
    vi.stubGlobal('window', { ipc: { remoteAuthority: 'wsl+Ubuntu' } })
    expect(windowArgvRemoteAuthority()).toBe('wsl+ubuntu')
  })

  it('windowArgvRemoteAuthority returns undefined when ipc exposes no authority', () => {
    vi.stubGlobal('window', { ipc: {} })
    expect(windowArgvRemoteAuthority()).toBeUndefined()
  })

  it('remoteAuthorityFromWorkspace derives the remote authority', () => {
    expect(remoteAuthorityFromWorkspace({ folder: remote('myhost') })).toBe('myhost')
    expect(remoteAuthorityFromWorkspace({ folder: remote('wsl+Ubuntu') })).toBe('wsl+ubuntu')
  })

  it('remoteAuthorityFromWorkspace returns undefined for a local folder or no folder', () => {
    expect(remoteAuthorityFromWorkspace({ folder: URI.file('/tmp') })).toBeUndefined()
    expect(remoteAuthorityFromWorkspace(null)).toBeUndefined()
    expect(remoteAuthorityFromWorkspace(undefined)).toBeUndefined()
  })

  it('currentRemoteAuthority prefers the workspace and never falls back for a local one', () => {
    vi.stubGlobal('window', { ipc: { remoteAuthority: 'wsl+Ubuntu' } })
    expect(currentRemoteAuthority({ folder: remote('myhost') })).toBe('myhost')
    expect(currentRemoteAuthority({ folder: URI.file('/tmp') })).toBeUndefined()
  })

  it('currentRemoteAuthority falls back to argv for an empty window', () => {
    vi.stubGlobal('window', { ipc: { remoteAuthority: 'wsl+Ubuntu' } })
    expect(currentRemoteAuthority(null)).toBe('wsl+ubuntu')
    expect(currentRemoteAuthority(undefined)).toBe('wsl+ubuntu')
  })
})
