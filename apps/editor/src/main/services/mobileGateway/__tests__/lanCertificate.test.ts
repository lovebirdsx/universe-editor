import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { X509Certificate, createPrivateKey } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { mkTempDir, removeDirWithRetry } from '@universe-editor/temp-root'
import {
  ensureLanCertificate,
  fingerprintOf,
  LAN_CERTIFICATE_FILE,
  LAN_PRIVATE_KEY_FILE,
  LAN_CERTIFICATE_RENEW_BEFORE_DAYS,
} from '../lanCertificate.js'

const NOW = Date.parse('2026-11-08T00:00:00Z')
const DAY_MS = 24 * 60 * 60 * 1000

describe('ensureLanCertificate', () => {
  let dir: string

  beforeEach(() => {
    dir = mkTempDir('ue-mobile-tls-')
  })

  afterEach(() => {
    removeDirWithRetry(dir)
  })

  it('issues a self-signed certificate covering the LAN address', async () => {
    const result = await ensureLanCertificate({
      dir,
      addresses: ['192.0.2.10', 'dev.example.com'],
      now: () => NOW,
    })

    expect(result.renewed).toBe(true)
    expect(result.addresses).toEqual(['192.0.2.10', 'dev.example.com'])
    expect(result.fingerprint).toMatch(/^[0-9a-f]{64}$/u)
    expect(result.expiresAt).toBeGreaterThan(NOW)

    const certificate = new X509Certificate(result.cert)
    expect(certificate.subjectAltName).toContain('IP Address:192.0.2.10')
    expect(certificate.subjectAltName).toContain('DNS:dev.example.com')
    expect(certificate.checkPrivateKey(createPrivateKey(result.key))).toBe(true)
    expect(fingerprintOf(certificate)).toBe(result.fingerprint)

    await expect(fs.readFile(join(dir, LAN_CERTIFICATE_FILE), 'utf8')).resolves.toContain(
      'BEGIN CERTIFICATE',
    )
    await expect(fs.readFile(join(dir, LAN_PRIVATE_KEY_FILE), 'utf8')).resolves.toContain(
      'BEGIN PRIVATE KEY',
    )
  })

  it.skipIf(process.platform === 'win32')(
    'writes the certificate and key with mode 0600',
    async () => {
      await ensureLanCertificate({ dir, addresses: ['192.0.2.10'], now: () => NOW })
      for (const name of [LAN_CERTIFICATE_FILE, LAN_PRIVATE_KEY_FILE]) {
        expect((await fs.stat(join(dir, name))).mode & 0o777).toBe(0o600)
      }
    },
  )

  it('reuses a matching certificate instead of issuing a new one', async () => {
    const first = await ensureLanCertificate({
      dir,
      addresses: ['192.0.2.10'],
      now: () => NOW,
    })
    const second = await ensureLanCertificate({
      dir,
      addresses: ['192.0.2.10'],
      now: () => NOW + DAY_MS,
    })

    expect(second.renewed).toBe(false)
    expect(second.fingerprint).toBe(first.fingerprint)
    expect(second.cert).toBe(first.cert)
  })

  it('renews when the LAN address changed', async () => {
    const first = await ensureLanCertificate({
      dir,
      addresses: ['192.0.2.10'],
      now: () => NOW,
    })
    const second = await ensureLanCertificate({
      dir,
      addresses: ['192.0.2.11'],
      now: () => NOW,
    })

    expect(second.renewed).toBe(true)
    expect(second.fingerprint).not.toBe(first.fingerprint)
    expect(new X509Certificate(second.cert).subjectAltName).toContain('IP Address:192.0.2.11')
  })

  it('renews when the remaining lifetime is below the renewal window', async () => {
    const first = await ensureLanCertificate({
      dir,
      addresses: ['192.0.2.10'],
      now: () => NOW,
      validityDays: 10,
    })
    const second = await ensureLanCertificate({
      dir,
      addresses: ['192.0.2.10'],
      now: () => NOW,
    })

    expect(second.renewed).toBe(true)
    expect(second.fingerprint).not.toBe(first.fingerprint)
    expect(second.expiresAt - NOW).toBeGreaterThan(LAN_CERTIFICATE_RENEW_BEFORE_DAYS * DAY_MS)
  })

  it('regenerates when the stored certificate is unreadable', async () => {
    await fs.writeFile(join(dir, LAN_CERTIFICATE_FILE), 'not a certificate', 'utf8')
    await fs.writeFile(join(dir, LAN_PRIVATE_KEY_FILE), 'not a key', 'utf8')

    const result = await ensureLanCertificate({
      dir,
      addresses: ['192.0.2.10'],
      now: () => NOW,
    })
    expect(result.renewed).toBe(true)
  })

  it('rejects an empty address list', async () => {
    await expect(ensureLanCertificate({ dir, addresses: [], now: () => NOW })).rejects.toThrow(
      'at least one address',
    )
  })
})
