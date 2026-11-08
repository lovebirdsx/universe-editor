/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Allow-list for Web Push endpoint hosts. The gateway POSTs to this URL, so an
 *  unvalidated endpoint would let a paired phone turn the PC into an SSRF
 *  launcher against the local network or cloud metadata services.
 *--------------------------------------------------------------------------------------------*/

/** Exact hosts used by the major push services. */
const EXACT_HOSTS: ReadonlySet<string> = new Set([
  'fcm.googleapis.com',
  'web.push.apple.com',
  'updates.push.services.mozilla.com',
])

/** Host suffixes for services that allocate a per-tenant subdomain. */
const HOST_SUFFIXES: readonly string[] = [
  '.push.apple.com',
  '.fcm.googleapis.com',
  '.push.services.mozilla.com',
  '.notify.windows.com',
  '.push.samsungosp.com',
]

/**
 * True when `endpoint` is an HTTPS URL owned by a known push service. The
 * protocol layer already rejects non-HTTPS and credentials-in-URL; this adds
 * the host allow-list that only the gateway can enforce.
 */
export function isAllowedPushEndpoint(endpoint: string): boolean {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return false
  }
  if (url.protocol !== 'https:') return false
  if (url.username !== '' || url.password !== '') return false
  const host = url.hostname.toLowerCase()
  if (host === '') return false
  if (EXACT_HOSTS.has(host)) return true
  return HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))
}
