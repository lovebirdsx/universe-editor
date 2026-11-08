import { describe, expect, it } from 'vitest'
import { isAllowedPushEndpoint } from '../pushEndpoint.js'

describe('isAllowedPushEndpoint', () => {
  it('accepts exact hosts of the major push services', () => {
    expect(isAllowedPushEndpoint('https://fcm.googleapis.com/fcm/send/abc')).toBe(true)
    expect(isAllowedPushEndpoint('https://web.push.apple.com/abc')).toBe(true)
    expect(isAllowedPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/abc')).toBe(
      true,
    )
  })

  it('accepts per-tenant subdomains of known services', () => {
    expect(isAllowedPushEndpoint('https://wns2-par02p.notify.windows.com/w/?token=abc')).toBe(true)
    expect(isAllowedPushEndpoint('https://abc.push.services.mozilla.com/wpush/v2/abc')).toBe(true)
    expect(isAllowedPushEndpoint('https://abc.push.samsungosp.com/abc')).toBe(true)
  })

  it('rejects unrelated hosts', () => {
    expect(isAllowedPushEndpoint('https://192.0.2.5/push')).toBe(false)
    expect(isAllowedPushEndpoint('https://example.com/push')).toBe(false)
    expect(isAllowedPushEndpoint('https://fcm.googleapis.com.example.com/push')).toBe(false)
    expect(isAllowedPushEndpoint('https://evilfcm.googleapis.com/push')).toBe(false)
  })

  it('rejects cleartext, credentials and malformed URLs', () => {
    expect(isAllowedPushEndpoint('http://fcm.googleapis.com/fcm/send/abc')).toBe(false)
    expect(isAllowedPushEndpoint('https://user:pass@fcm.googleapis.com/fcm/send/abc')).toBe(false)
    expect(isAllowedPushEndpoint('not a url')).toBe(false)
    expect(isAllowedPushEndpoint('')).toBe(false)
  })

  it('matches hosts without leaking case sensitivity', () => {
    expect(isAllowedPushEndpoint('https://FCM.GOOGLEAPIS.COM/fcm/send/abc')).toBe(true)
  })
})
