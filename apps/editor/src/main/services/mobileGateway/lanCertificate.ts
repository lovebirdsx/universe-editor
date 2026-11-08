/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Self-signed certificate for the LAN tier. The certificate and key live in
 *  `<userData>/mobile/tls` with mode 0600 and are replaced atomically. A stored
 *  certificate is reused only while it covers every current LAN address and is
 *  far enough from expiry; otherwise a fresh pair is issued. Node's crypto
 *  module can parse X.509 but not issue it, so issuance goes through
 *  `selfsigned` (WebCrypto based, no native addon).
 *--------------------------------------------------------------------------------------------*/

import { X509Certificate, createPrivateKey } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { join } from 'node:path'
import selfsigned from 'selfsigned'
import { chmodPrivate, writeFileAtomic } from './atomicFile.js'

export const LAN_CERTIFICATE_FILE = 'cert.pem'
export const LAN_PRIVATE_KEY_FILE = 'key.pem'
export const LAN_CERTIFICATE_VALIDITY_DAYS = 365
export const LAN_CERTIFICATE_RENEW_BEFORE_DAYS = 30

const DAY_MS = 24 * 60 * 60 * 1000
const CLOCK_SKEW_MS = 5 * 60 * 1000

export interface LanCertificate {
  readonly cert: string
  readonly key: string
  /** Lowercase hex SHA-256 of the DER certificate. */
  readonly fingerprint: string
  /** Addresses the certificate is valid for (IP or DNS). */
  readonly addresses: readonly string[]
  /** Epoch milliseconds. */
  readonly expiresAt: number
  readonly renewed: boolean
}

export interface EnsureLanCertificateOptions {
  readonly dir: string
  readonly addresses: readonly string[]
  readonly now?: () => number
  readonly validityDays?: number
  readonly renewBeforeDays?: number
  readonly onChmodError?: (error: Error) => void
}

/**
 * Reuse the stored certificate when it still matches the current LAN address
 * and is not close to expiry; otherwise issue and persist a new one.
 */
export async function ensureLanCertificate(
  options: EnsureLanCertificateOptions,
): Promise<LanCertificate> {
  const addresses = normalizeAddresses(options.addresses)
  if (addresses.length === 0) throw new Error('LAN certificate requires at least one address')

  const now = (options.now ?? Date.now)()
  const renewBeforeMs = (options.renewBeforeDays ?? LAN_CERTIFICATE_RENEW_BEFORE_DAYS) * DAY_MS
  const existing = await readStoredCertificate(options.dir, addresses, now, renewBeforeMs)
  if (existing !== undefined) {
    await chmodPrivate(join(options.dir, LAN_CERTIFICATE_FILE), options.onChmodError)
    await chmodPrivate(join(options.dir, LAN_PRIVATE_KEY_FILE), options.onChmodError)
    return { ...existing, renewed: false }
  }

  const validityDays = options.validityDays ?? LAN_CERTIFICATE_VALIDITY_DAYS
  const generated = await selfsigned.generate(
    [{ name: 'commonName', value: 'universe-editor-mobile' }],
    {
      keyType: 'ec',
      curve: 'P-256',
      algorithm: 'sha256',
      notBeforeDate: new Date(now - CLOCK_SKEW_MS),
      notAfterDate: new Date(now + validityDays * DAY_MS),
      extensions: [
        { name: 'basicConstraints', cA: false, critical: true },
        {
          name: 'keyUsage',
          digitalSignature: true,
          keyEncipherment: true,
          critical: true,
        },
        { name: 'extKeyUsage', serverAuth: true, critical: false },
        { name: 'subjectAltName', altNames: sanEntries(addresses), critical: false },
      ],
    },
  )

  const cert = `${generated.cert.trim()}\n`
  const key = `${generated.private.trim()}\n`
  const certificate = new X509Certificate(cert)
  const fingerprint = fingerprintOf(certificate)

  // Key first: a crash between the two writes leaves a mismatched pair that the
  // next startup detects and replaces, never a cert without its key.
  await writeFileAtomic(join(options.dir, LAN_PRIVATE_KEY_FILE), key, options.onChmodError)
  await writeFileAtomic(join(options.dir, LAN_CERTIFICATE_FILE), cert, options.onChmodError)

  return {
    cert,
    key,
    fingerprint,
    addresses,
    expiresAt: Date.parse(certificate.validTo),
    renewed: true,
  }
}

/** Lowercase hex SHA-256 as shown by browsers and used in pairing URLs. */
export function fingerprintOf(certificate: X509Certificate): string {
  return certificate.fingerprint256.replace(/:/g, '').toLowerCase()
}

/** True when the certificate covers every address and has enough validity left. */
export function certificateMatches(
  certificate: X509Certificate,
  keyPem: string,
  addresses: readonly string[],
  now: number,
  renewBeforeMs: number,
): boolean {
  let key
  try {
    key = createPrivateKey(keyPem)
  } catch {
    return false
  }
  if (!certificate.checkPrivateKey(key)) return false

  const validFrom = Date.parse(certificate.validFrom)
  const validTo = Date.parse(certificate.validTo)
  if (!Number.isFinite(validFrom) || !Number.isFinite(validTo)) return false
  if (validFrom - CLOCK_SKEW_MS > now) return false
  if (validTo - now <= renewBeforeMs) return false

  const san = certificate.subjectAltName ?? ''
  for (const address of addresses) {
    const entry = isIP(address) === 0 ? `DNS:${address}` : `IP Address:${address}`
    if (!sanIncludes(san, entry)) return false
  }
  return true
}

function sanIncludes(san: string, entry: string): boolean {
  return san.split(/,\s*/u).some((part) => part.trim().toLowerCase() === entry.toLowerCase())
}

async function readStoredCertificate(
  dir: string,
  addresses: readonly string[],
  now: number,
  renewBeforeMs: number,
): Promise<Omit<LanCertificate, 'renewed'> | undefined> {
  let cert: string
  let key: string
  try {
    cert = await readFile(join(dir, LAN_CERTIFICATE_FILE), 'utf8')
    key = await readFile(join(dir, LAN_PRIVATE_KEY_FILE), 'utf8')
  } catch {
    return undefined
  }

  let certificate: X509Certificate
  try {
    certificate = new X509Certificate(cert)
  } catch {
    return undefined
  }
  if (!certificateMatches(certificate, key, addresses, now, renewBeforeMs)) return undefined

  return {
    cert: cert.endsWith('\n') ? cert : `${cert}\n`,
    key: key.endsWith('\n') ? key : `${key}\n`,
    fingerprint: fingerprintOf(certificate),
    addresses,
    expiresAt: Date.parse(certificate.validTo),
  }
}

function normalizeAddresses(addresses: readonly string[]): string[] {
  const result: string[] = []
  for (const raw of addresses) {
    const value = raw.trim()
    if (value !== '' && !result.includes(value)) result.push(value)
  }
  return result
}

function sanEntries(addresses: readonly string[]): { type: 2 | 7; value?: string; ip?: string }[] {
  return addresses.map((address) =>
    isIP(address) === 0 ? { type: 2 as const, value: address } : { type: 7 as const, ip: address },
  )
}
