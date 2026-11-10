/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  TLS trust diagnostics for the LAN tier. A rejected certificate fails before
 *  HTTP exists, so the phone cannot report it and the gateway must surface it.
 *--------------------------------------------------------------------------------------------*/

/** Both OpenSSL's text and the raw alert 46 mean the client rejected our chain. */
const CERTIFICATE_REJECTION = /certificate_unknown|alert number 46|unknown ca/iu

export function isCertificateRejection(detail: string): boolean {
  return CERTIFICATE_REJECTION.test(detail)
}

/**
 * The PC's own browser also probes the HTTPS origin and may reject a self-signed
 * certificate before the user accepts it; that is not a phone-side trust problem.
 */
export function isLocalTlsClient(remoteAddress: string, boundHost: string | undefined): boolean {
  const address = remoteAddress.startsWith('::ffff:') ? remoteAddress.slice(7) : remoteAddress
  if (address === '' || address === '127.0.0.1' || address === '::1') return true
  return boundHost !== undefined && address === boundHost
}
