/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  TLS identity for the LAN tier. Two modes share the same leaf files:
 *
 *  - `self-signed`: one leaf the phone accepts through the browser warning.
 *  - `root-ca`: a long-lived root CA signs a short-lived leaf. The root is
 *    installed once on the phone, so leaf renewal does not break trust.
 *
 *  The leaf reused only while it covers every current LAN address and is far
 *  enough from expiry; the CA is reused while it is intact and unexpired.
 *  Node's crypto module can parse X.509 but not issue it, so issuance goes
 *  through `selfsigned` (WebCrypto based, no native addon).
 *--------------------------------------------------------------------------------------------*/

import { X509Certificate, createPrivateKey } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { join } from 'node:path'
import selfsigned from 'selfsigned'
import { chmodPrivate, writeFileAtomic } from './atomicFile.js'

export const LAN_CERTIFICATE_FILE = 'cert.pem'
export const LAN_PRIVATE_KEY_FILE = 'key.pem'
export const LAN_CA_CERTIFICATE_FILE = 'ca-cert.pem'
export const LAN_CA_PRIVATE_KEY_FILE = 'ca-key.pem'
export const LAN_CERTIFICATE_VALIDITY_DAYS = 365
export const LAN_CERTIFICATE_RENEW_BEFORE_DAYS = 30
export const LAN_CA_VALIDITY_DAYS = 3650

const LEAF_COMMON_NAME = 'universe-editor-mobile'
const CA_COMMON_NAME = 'universe-editor-mobile-root'

const DAY_MS = 24 * 60 * 60 * 1000
const CLOCK_SKEW_MS = 5 * 60 * 1000

export type LanCertificateMode = 'self-signed' | 'root-ca'

export interface LanCertificateAuthority {
  readonly cert: string
  /** Lowercase hex SHA-256 of the DER certificate. */
  readonly fingerprint: string
  /** Epoch milliseconds. */
  readonly expiresAt: number
}

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
  /** Present in `root-ca` mode: the root that signs `cert`. */
  readonly ca?: LanCertificateAuthority
}

export interface EnsureLanCertificateOptions {
  readonly dir: string
  readonly addresses: readonly string[]
  /** Defaults to `self-signed`; switching modes reissues the leaf. */
  readonly mode?: LanCertificateMode
  readonly now?: () => number
  readonly validityDays?: number
  readonly renewBeforeDays?: number
  readonly onChmodError?: (error: Error) => void
}

interface StoredAuthority {
  readonly cert: string
  readonly key: string
  readonly x509: X509Certificate
  readonly fingerprint: string
  readonly expiresAt: number
}

interface StoredLeaf {
  readonly cert: string
  readonly key: string
  readonly fingerprint: string
  readonly addresses: readonly string[]
  readonly expiresAt: number
}

interface IssuedLeaf {
  readonly cert: string
  readonly private: string
}

/**
 * Reuse the stored identity when it still matches the current LAN addresses and
 * is not close to expiry; otherwise issue and persist a new one.
 */
export async function ensureLanCertificate(
  options: EnsureLanCertificateOptions,
): Promise<LanCertificate> {
  const addresses = normalizeAddresses(options.addresses)
  if (addresses.length === 0) throw new Error('LAN certificate requires at least one address')

  const now = (options.now ?? Date.now)()
  const renewBeforeMs = (options.renewBeforeDays ?? LAN_CERTIFICATE_RENEW_BEFORE_DAYS) * DAY_MS

  if ((options.mode ?? 'self-signed') === 'root-ca') {
    const authority = await ensureCertificateAuthority(options, now, renewBeforeMs)
    const ca = {
      cert: authority.cert,
      fingerprint: authority.fingerprint,
      expiresAt: authority.expiresAt,
    }
    const existing = await readStoredLeaf(
      options.dir,
      addresses,
      now,
      renewBeforeMs,
      authority.x509,
    )
    if (existing !== undefined) {
      await chmodLeafFiles(options.dir, options.onChmodError)
      return { ...existing, renewed: false, ca }
    }
    const generated = await generateLeaf(options, addresses, now, authority)
    const leaf = await persistLeaf(options.dir, generated, addresses, options.onChmodError)
    return { ...leaf, renewed: true, ca }
  }

  // Switching back from `root-ca` must not keep serving a CA-signed leaf.
  const existing = await readStoredLeaf(options.dir, addresses, now, renewBeforeMs, 'self')
  if (existing !== undefined) {
    await chmodLeafFiles(options.dir, options.onChmodError)
    return { ...existing, renewed: false }
  }
  const generated = await generateLeaf(options, addresses, now, undefined)
  const leaf = await persistLeaf(options.dir, generated, addresses, options.onChmodError)
  return { ...leaf, renewed: true }
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

async function ensureCertificateAuthority(
  options: EnsureLanCertificateOptions,
  now: number,
  renewBeforeMs: number,
): Promise<StoredAuthority> {
  const existing = await readStoredAuthority(options.dir, now, renewBeforeMs)
  if (existing !== undefined) {
    await chmodPrivate(join(options.dir, LAN_CA_CERTIFICATE_FILE), options.onChmodError)
    await chmodPrivate(join(options.dir, LAN_CA_PRIVATE_KEY_FILE), options.onChmodError)
    return existing
  }

  const generated = await selfsigned.generate([{ name: 'commonName', value: CA_COMMON_NAME }], {
    keyType: 'ec',
    curve: 'P-256',
    algorithm: 'sha256',
    notBeforeDate: new Date(now - CLOCK_SKEW_MS),
    notAfterDate: new Date(now + LAN_CA_VALIDITY_DAYS * DAY_MS),
    extensions: [
      { name: 'basicConstraints', cA: true, pathLenConstraint: 0, critical: true },
      { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    ],
  })
  const cert = `${generated.cert.trim()}\n`
  const key = `${generated.private.trim()}\n`
  const certificate = new X509Certificate(cert)
  await writeFileAtomic(join(options.dir, LAN_CA_PRIVATE_KEY_FILE), key, options.onChmodError)
  await writeFileAtomic(join(options.dir, LAN_CA_CERTIFICATE_FILE), cert, options.onChmodError)
  return {
    cert,
    key,
    x509: certificate,
    fingerprint: fingerprintOf(certificate),
    expiresAt: Date.parse(certificate.validTo),
  }
}

async function readStoredAuthority(
  dir: string,
  now: number,
  renewBeforeMs: number,
): Promise<StoredAuthority | undefined> {
  let cert: string
  let key: string
  try {
    cert = await readFile(join(dir, LAN_CA_CERTIFICATE_FILE), 'utf8')
    key = await readFile(join(dir, LAN_CA_PRIVATE_KEY_FILE), 'utf8')
  } catch {
    return undefined
  }

  let certificate: X509Certificate
  try {
    certificate = new X509Certificate(cert)
    const privateKey = createPrivateKey(key)
    if (!certificate.checkPrivateKey(privateKey)) return undefined
  } catch {
    return undefined
  }
  if (!certificate.ca) return undefined
  if (!hasEnoughValidity(certificate, now, renewBeforeMs)) return undefined

  return {
    cert: cert.endsWith('\n') ? cert : `${cert}\n`,
    key: key.endsWith('\n') ? key : `${key}\n`,
    x509: certificate,
    fingerprint: fingerprintOf(certificate),
    expiresAt: Date.parse(certificate.validTo),
  }
}

async function readStoredLeaf(
  dir: string,
  addresses: readonly string[],
  now: number,
  renewBeforeMs: number,
  issuer: X509Certificate | 'self',
): Promise<StoredLeaf | undefined> {
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

  const expectedIssuer = issuer === 'self' ? certificate : issuer
  try {
    if (!certificate.verify(expectedIssuer.publicKey)) return undefined
  } catch {
    return undefined
  }
  if (issuer !== 'self' && certificate.ca) return undefined

  return {
    cert: cert.endsWith('\n') ? cert : `${cert}\n`,
    key: key.endsWith('\n') ? key : `${key}\n`,
    fingerprint: fingerprintOf(certificate),
    addresses,
    expiresAt: Date.parse(certificate.validTo),
  }
}

async function generateLeaf(
  options: EnsureLanCertificateOptions,
  addresses: readonly string[],
  now: number,
  ca: StoredAuthority | undefined,
): Promise<IssuedLeaf> {
  const validityDays = options.validityDays ?? LAN_CERTIFICATE_VALIDITY_DAYS
  return selfsigned.generate([{ name: 'commonName', value: LEAF_COMMON_NAME }], {
    keyType: 'ec',
    curve: 'P-256',
    algorithm: 'sha256',
    notBeforeDate: new Date(now - CLOCK_SKEW_MS),
    notAfterDate: new Date(now + validityDays * DAY_MS),
    ...(ca !== undefined ? { ca: { key: ca.key, cert: ca.cert } } : {}),
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
  })
}

async function persistLeaf(
  dir: string,
  generated: IssuedLeaf,
  addresses: readonly string[],
  onChmodError: ((error: Error) => void) | undefined,
): Promise<StoredLeaf> {
  const cert = `${generated.cert.trim()}\n`
  const key = `${generated.private.trim()}\n`
  const certificate = new X509Certificate(cert)

  // Key first: a crash between the two writes leaves a mismatched pair that the
  // next startup detects and replaces, never a cert without its key.
  await writeFileAtomic(join(dir, LAN_PRIVATE_KEY_FILE), key, onChmodError)
  await writeFileAtomic(join(dir, LAN_CERTIFICATE_FILE), cert, onChmodError)

  return {
    cert,
    key,
    fingerprint: fingerprintOf(certificate),
    addresses,
    expiresAt: Date.parse(certificate.validTo),
  }
}

async function chmodLeafFiles(
  dir: string,
  onChmodError: ((error: Error) => void) | undefined,
): Promise<void> {
  await chmodPrivate(join(dir, LAN_CERTIFICATE_FILE), onChmodError)
  await chmodPrivate(join(dir, LAN_PRIVATE_KEY_FILE), onChmodError)
}

function hasEnoughValidity(
  certificate: X509Certificate,
  now: number,
  renewBeforeMs: number,
): boolean {
  const validFrom = Date.parse(certificate.validFrom)
  const validTo = Date.parse(certificate.validTo)
  if (!Number.isFinite(validFrom) || !Number.isFinite(validTo)) return false
  if (validFrom - CLOCK_SKEW_MS > now) return false
  return validTo - now > renewBeforeMs
}

function sanIncludes(san: string, entry: string): boolean {
  return san.split(/,\s*/u).some((part) => part.trim().toLowerCase() === entry.toLowerCase())
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
