/*---------------------------------------------------------------------------------------------
 *  Tests for RemoteConnectIntentService — the per-window record of authorities
 *  this window started connecting, keyed exactly like the connection state
 *  events (WSL authorities lowercased, SSH authorities case-sensitive).
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { RemoteConnectIntentService } from '../RemoteConnectIntentService.js'

describe('RemoteConnectIntentService', () => {
  it('tracks begin/end and end is idempotent', () => {
    const service = new RemoteConnectIntentService()
    expect(service.has('myhost')).toBe(false)

    service.begin('myhost')
    expect(service.has('myhost')).toBe(true)

    service.end('myhost')
    expect(service.has('myhost')).toBe(false)
    service.end('myhost')
    expect(service.has('myhost')).toBe(false)

    service.dispose()
  })

  it('normalizes a WSL authority so lookup matches the state event key', () => {
    const service = new RemoteConnectIntentService()
    service.begin('wsl+Ubuntu')
    expect(service.has('wsl+ubuntu')).toBe(true)
    expect(service.has('wsl+Ubuntu')).toBe(true)
    service.dispose()
  })

  it('keeps ssh authorities case-sensitive', () => {
    const service = new RemoteConnectIntentService()
    service.begin('MyHost')
    expect(service.has('myhost')).toBe(false)
    expect(service.has('MyHost')).toBe(true)
    service.dispose()
  })

  it('tracks authorities independently', () => {
    const service = new RemoteConnectIntentService()
    service.begin('alpha')
    service.begin('beta')
    service.end('alpha')
    expect(service.has('alpha')).toBe(false)
    expect(service.has('beta')).toBe(true)
    service.dispose()
  })
})
