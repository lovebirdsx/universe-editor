import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { X509Certificate, createPrivateKey } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { mkTempDir, removeDirWithRetry } from '@universe-editor/temp-root'
import {
  ensureLanCertificate,
  fingerprintOf,
  LAN_CA_CERTIFICATE_FILE,
  LAN_CA_PRIVATE_KEY_FILE,
  LAN_CA_VALIDITY_DAYS,
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

describe('ensureLanCertificate root-ca mode', () => {
  let dir: string

  beforeEach(() => {
    dir = mkTempDir('ue-mobile-tls-ca-')
  })

  afterEach(() => {
    removeDirWithRetry(dir)
  })

  function issue(addresses: readonly string[], now = NOW) {
    return ensureLanCertificate({ dir, addresses, mode: 'root-ca', now: () => now })
  }

  it('issues a leaf signed by a long-lived root CA', async () => {
    const result = await issue(['192.0.2.10', 'dev.example.com'])

    expect(result.renewed).toBe(true)
    expect(result.ca).toBeDefined()
    const ca = new X509Certificate(result.ca!.cert)
    const leaf = new X509Certificate(result.cert)
    expect(ca.ca).toBe(true)
    expect(leaf.ca).toBe(false)
    expect(leaf.verify(ca.publicKey)).toBe(true)
    expect(leaf.checkPrivateKey(createPrivateKey(result.key))).toBe(true)
    expect(leaf.subjectAltName).toContain('IP Address:192.0.2.10')
    expect(leaf.subjectAltName).toContain('DNS:dev.example.com')
    expect(result.ca!.fingerprint).toBe(fingerprintOf(ca))
    expect(result.ca!.expiresAt - NOW).toBeGreaterThan((LAN_CA_VALIDITY_DAYS - 1) * DAY_MS)

    await expect(fs.readFile(join(dir, LAN_CA_CERTIFICATE_FILE), 'utf8')).resolves.toContain(
      'BEGIN CERTIFICATE',
    )
    await expect(fs.readFile(join(dir, LAN_CA_PRIVATE_KEY_FILE), 'utf8')).resolves.toContain(
      'BEGIN PRIVATE KEY',
    )
  })

  it('keeps the root while reissuing the leaf for a new address', async () => {
    const first = await issue(['192.0.2.10'])
    const second = await issue(['192.0.2.11'], NOW + DAY_MS)

    expect(second.renewed).toBe(true)
    expect(second.ca!.fingerprint).toBe(first.ca!.fingerprint)
    expect(second.cert).not.toBe(first.cert)
    expect(
      new X509Certificate(first.cert).verify(new X509Certificate(second.ca!.cert).publicKey),
    ).toBe(true)
  })

  it('reuses both the root and the leaf when nothing changed', async () => {
    const first = await issue(['192.0.2.10'])
    const second = await issue(['192.0.2.10'], NOW + DAY_MS)

    expect(second.renewed).toBe(false)
    expect(second.fingerprint).toBe(first.fingerprint)
    expect(second.ca!.fingerprint).toBe(first.ca!.fingerprint)
  })

  it('replaces a corrupt root CA and re-signs the leaf', async () => {
    await fs.writeFile(join(dir, LAN_CA_CERTIFICATE_FILE), 'not a certificate', 'utf8')
    await fs.writeFile(join(dir, LAN_CA_PRIVATE_KEY_FILE), 'not a key', 'utf8')

    const result = await issue(['192.0.2.10'])
    expect(result.renewed).toBe(true)
    expect(new X509Certificate(result.ca!.cert).ca).toBe(true)
    expect(
      new X509Certificate(result.cert).verify(new X509Certificate(result.ca!.cert).publicKey),
    ).toBe(true)
  })

  it('does not reuse a leaf issued by the other mode', async () => {
    const selfSigned = await ensureLanCertificate({
      dir,
      addresses: ['192.0.2.10'],
      now: () => NOW,
    })
    const rooted = await issue(['192.0.2.10'])
    expect(rooted.renewed).toBe(true)
    expect(rooted.ca).toBeDefined()
    expect(rooted.fingerprint).not.toBe(selfSigned.fingerprint)

    const back = await ensureLanCertificate({
      dir,
      addresses: ['192.0.2.10'],
      mode: 'self-signed',
      now: () => NOW,
    })
    expect(back.renewed).toBe(true)
    expect(back.ca).toBeUndefined()
    expect(new X509Certificate(back.cert).verify(new X509Certificate(back.cert).publicKey)).toBe(
      true,
    )
  })

  it.skipIf(process.platform === 'win32')('writes the CA key with mode 0600', async () => {
    await issue(['192.0.2.10'])
    for (const name of [
      LAN_CERTIFICATE_FILE,
      LAN_PRIVATE_KEY_FILE,
      LAN_CA_CERTIFICATE_FILE,
      LAN_CA_PRIVATE_KEY_FILE,
    ]) {
      expect((await fs.stat(join(dir, name))).mode & 0o777).toBe(0o600)
    }
  })
})
