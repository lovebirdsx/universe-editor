/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Pure helpers for the Mobile Devices settings page: pairing URL selection,
 *  expiry/countdown math, audit labels and time formatting. Kept free of React
 *  and services so the rules can be unit tested directly.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '@universe-editor/platform'
import type {
  MobileAuditEntry,
  MobileDeviceInfo,
} from '../../../shared/ipc/mobileGatewayService.js'

/** Main mints this sentinel for the fixed e2e pairing code. */
export const FIXED_PAIRING_EXPIRY = Number.MAX_SAFE_INTEGER

/** Pick the origin a phone can actually install / receive push from, if any. */
export function choosePairUrl(urls: readonly string[]): string | undefined {
  return urls.find((url) => url.startsWith('https://')) ?? urls[0]
}

/** Origin to hand to this computer's own browser: loopback HTTP first, then HTTPS. */
export function chooseDesktopOrigin(origins: readonly string[]): string | undefined {
  return (
    origins.find((url) => url.startsWith('http://127.0.0.1:')) ??
    origins.find((url) => url.startsWith('http://localhost:')) ??
    origins.find((url) => url.startsWith('https://')) ??
    origins[0]
  )
}

/** Index of the preferred pairing URL; 0 when none is HTTPS. */
export function preferredPairUrlIndex(urls: readonly string[]): number {
  const index = urls.findIndex((url) => url.startsWith('https://'))
  return index >= 0 ? index : 0
}

/** Human-readable origin for a pair URL (`https://host`), dropping `/pair#…`. */
export function pairUrlLabel(url: string): string {
  return url.replace(/\/pair#.*$/u, '')
}

export function isFixedPairingExpiry(expiresAt: number): boolean {
  return expiresAt === FIXED_PAIRING_EXPIRY
}

/** Milliseconds left before the code expires; `Infinity` for the fixed e2e code. */
export function pairingRemainingMs(expiresAt: number, now: number): number {
  if (isFixedPairingExpiry(expiresAt)) return Number.POSITIVE_INFINITY
  return Math.max(0, expiresAt - now)
}

/** `m:ss` countdown label. */
export function formatCountdown(remainingMs: number): string {
  const totalSeconds = Number.isFinite(remainingMs) ? Math.max(0, Math.ceil(remainingMs / 1000)) : 0
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

/** Browser-style SHA-256 display: uppercase, colon-separated byte pairs. */
export function formatFingerprint(fingerprint: string): string {
  const pairs = fingerprint.toLowerCase().match(/.{2}/gu)
  return pairs === null ? fingerprint : pairs.join(':').toUpperCase()
}

/** Local wall-clock timestamp, deterministic regardless of locale. */
export function formatTimestamp(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return '—'
  const date = new Date(ts)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** First device in `devices` whose id was not in `known` — a fresh pairing. */
export function findNewDevice(
  known: ReadonlySet<string>,
  devices: readonly MobileDeviceInfo[],
): MobileDeviceInfo | undefined {
  return devices.find((device) => !known.has(device.deviceId))
}

export function devicePlatformLabel(platform: string): string {
  switch (platform) {
    case 'ios':
      return localize('mobileDevices.devices.platform.ios', 'iOS')
    case 'android':
      return localize('mobileDevices.devices.platform.android', 'Android')
    default:
      return localize('mobileDevices.devices.platform.other', 'Other')
  }
}

export function auditActionLabel(action: string): string {
  switch (action) {
    case 'pairing_started':
      return localize('mobileDevices.audit.action.pairingStarted', 'Pairing started')
    case 'pairing_cancelled':
      return localize('mobileDevices.audit.action.pairingCancelled', 'Pairing cancelled')
    case 'pair_attempt':
      return localize('mobileDevices.audit.action.pairAttempt', 'Pairing attempt')
    case 'device_connected':
      return localize('mobileDevices.audit.action.deviceConnected', 'Device connected')
    case 'device_revoked':
      return localize('mobileDevices.audit.action.deviceRevoked', 'Device revoked')
    case 'gateway_start':
      return localize('mobileDevices.audit.action.gatewayStart', 'Gateway started')
    case 'gateway_stop':
      return localize('mobileDevices.audit.action.gatewayStop', 'Gateway stopped')
    case 'gateway_error':
      return localize('mobileDevices.audit.action.gatewayError', 'Gateway error')
    case 'hello_failed':
      return localize('mobileDevices.audit.action.helloFailed', 'Authentication failed')
    case 'tls_handshake_failed':
      return localize('mobileDevices.audit.action.tlsHandshakeFailed', 'TLS handshake failed')
    case 'upgrade_rejected':
      return localize('mobileDevices.audit.action.upgradeRejected', 'Connection refused')
    case 'push_subscribe':
      return localize('mobileDevices.audit.action.pushSubscribe', 'Push notifications enabled')
    case 'push_unsubscribe':
      return localize('mobileDevices.audit.action.pushUnsubscribe', 'Push notifications disabled')
    default:
      return action
  }
}

export function auditDeviceLabel(entry: MobileAuditEntry): string {
  return entry.deviceName ?? entry.deviceId ?? entry.remoteAddress ?? '—'
}
