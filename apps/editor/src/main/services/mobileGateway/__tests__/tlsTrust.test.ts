/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { isCertificateRejection, isLocalTlsClient } from '../tlsTrust.js'

describe('isCertificateRejection', () => {
  it('matches the alert text reported by Node on Windows', () => {
    expect(
      isCertificateRejection('ERR_SSL_SSLV3_ALERT_CERTIFICATE_UNKNOWN: ... SSL alert number 46'),
    ).toBe(true)
  })

  it('matches the unknown-ca alert text reported on other platforms', () => {
    expect(isCertificateRejection('error:0A000418:SSL routines::tlsv1 alert unknown ca')).toBe(true)
  })

  it('ignores socket resets and unrelated TLS errors', () => {
    expect(isCertificateRejection('ECONNRESET: socket hang up')).toBe(false)
    expect(isCertificateRejection('ERR_SSL_WRONG_VERSION_NUMBER')).toBe(false)
  })
})

describe('isLocalTlsClient', () => {
  it('treats loopback (including IPv4-mapped IPv6) as the PC itself', () => {
    expect(isLocalTlsClient('127.0.0.1', '192.0.2.20')).toBe(true)
    expect(isLocalTlsClient('::1', '192.0.2.20')).toBe(true)
    expect(isLocalTlsClient('::ffff:127.0.0.1', '192.0.2.20')).toBe(true)
  })

  it('treats the bound address as the PC itself', () => {
    expect(isLocalTlsClient('192.0.2.20', '192.0.2.20')).toBe(true)
  })

  it('keeps remote clients visible', () => {
    expect(isLocalTlsClient('192.0.2.30', '192.0.2.20')).toBe(false)
  })
})
