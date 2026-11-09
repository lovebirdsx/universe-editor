/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Host / Origin validation for the gateway. The Host header must name the bind
 *  address, loopback, or a configured extra host (Tailscale `*.ts.net`). When an
 *  Origin is present it must be same-origin with Host. This is the DNS-rebinding
 *  guard: no CORS headers are ever emitted, and a mismatched Origin is rejected
 *  before routing.
 *--------------------------------------------------------------------------------------------*/

export interface RequestHeaders {
  readonly host: string | undefined
  readonly origin: string | undefined
}

export type HeaderCheckResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string }

/**
 * Host values accepted by the gateway, lowercased. Entries may be bare hosts
 * (`pc.example.com`, from Tailscale Serve) or `host:port`.
 */
export function buildAllowedHosts(options: {
  readonly bindHost: string
  readonly port: number
  readonly extraHosts?: readonly string[]
  /**
   * The PC's own host name (the certificate SAN carries it). Only `name:port`
   * is added: a bare name would claim the Tailscale Serve 443 origin, which is
   * exactly what `extraHosts` means.
   */
  readonly localHostnames?: readonly string[]
}): string[] {
  const allowed = new Set<string>()
  const add = (value: string): void => {
    const normalized = value.trim().toLowerCase()
    if (normalized !== '') allowed.add(normalized)
  }
  add(`${options.bindHost}:${options.port}`)
  add(`127.0.0.1:${options.port}`)
  add(`localhost:${options.port}`)
  for (const raw of options.localHostnames ?? []) {
    const host = normalizeHostEntry(raw)
    if (host === undefined) continue
    if (!host.startsWith('[') && !host.includes(':')) add(`${host}:${options.port}`)
  }
  for (const raw of options.extraHosts ?? []) {
    const host = normalizeHostEntry(raw)
    if (host === undefined) continue
    add(host)
    if (!host.startsWith('[') && !host.includes(':')) add(`${host}:${options.port}`)
  }
  return [...allowed]
}

/** Accepts `host`, `host:port`, or a full URL; returns the lowercased authority. */
export function normalizeHostEntry(entry: string): string | undefined {
  const trimmed = entry.trim()
  if (trimmed === '') return undefined
  if (trimmed.includes('://')) {
    try {
      return new URL(trimmed).host.toLowerCase()
    } catch {
      return undefined
    }
  }
  return trimmed.toLowerCase()
}

export function checkRequestHeaders(
  headers: RequestHeaders,
  allowedHosts: readonly string[],
): HeaderCheckResult {
  const host = headers.host?.trim().toLowerCase()
  if (host === undefined || host === '') return { ok: false, reason: 'missing host header' }
  if (!allowedHosts.includes(host)) return { ok: false, reason: 'host is not allowed' }

  if (headers.origin !== undefined) {
    let origin: URL
    try {
      origin = new URL(headers.origin)
    } catch {
      return { ok: false, reason: 'origin is not a valid URL' }
    }
    if (origin.protocol !== 'http:' && origin.protocol !== 'https:') {
      return { ok: false, reason: 'origin scheme is not allowed' }
    }
    if (origin.host.toLowerCase() !== host) {
      return { ok: false, reason: 'origin does not match host' }
    }
  }
  return { ok: true }
}
