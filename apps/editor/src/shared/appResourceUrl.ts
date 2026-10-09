/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Bridge a local fs path to/from the privileged
 *  `universe-app://root/_resource_/<abs-path>` URL that serves it (see
 *  main/ipc/resourceProtocol.ts). Both directions live here so the encoding and its
 *  inverse can't drift; shared across processes so the renderer, the main handler and
 *  tests agree on the mapping.
 *
 *  This URL is a *transport* address, never a resource identity. Anything that reads
 *  one from somewhere other than an `<img src>`/iframe (a drop payload, a webview
 *  message) must map it back with {@link resourceUrlToFsPath} before treating it as a
 *  file — otherwise it becomes a URI with a foreign scheme.
 *--------------------------------------------------------------------------------------------*/

export const RESOURCE_PROTOCOL_SCHEME = 'universe-app'
/** Path prefix (under the shell origin) that addresses an arbitrary local resource. */
export const RESOURCE_PATH_PREFIX = '_resource_'

// Resources share the shell's origin (authority `root`) and are addressed by a path
// prefix — a secure custom scheme treats a different authority as a separate origin,
// and a cross-origin <img> to a custom scheme is blocked before it can be served.
const RESOURCE_URL_BASE = `${RESOURCE_PROTOCOL_SCHEME}://root/${RESOURCE_PATH_PREFIX}`
const RESOURCE_URL_PATH_PREFIX = `/${RESOURCE_PATH_PREFIX}/`

/** Windows drive path (`F:`, `c:`) — carries no leading slash. */
const DRIVE_PATH_RE = /^[A-Za-z]:/

/** Percent-encode an absolute fs path into a `universe-app://root/_resource_/...` URL. */
export function toResourceUrl(fsPath: string): string {
  const forward = fsPath.replace(/\\/g, '/')
  const encoded = forward
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/')
  const leading = encoded.startsWith('/') ? '' : '/'
  return `${RESOURCE_URL_BASE}${leading}${encoded}`
}

/**
 * Inverse of {@link toResourceUrl}: the absolute fs path a resource URL serves, or
 * `undefined` when `url` isn't one (the shell, another scheme, a malformed escape) —
 * callers then fall back to their own parsing.
 *
 * Platform-free by construction: a drive path (`F:`) carries no leading slash, every
 * other absolute path does, which is exactly the slash {@link toResourceUrl} folds
 * away per segment — same rule as the main handler's `decodeResourcePath`, without
 * consulting `process.platform`.
 */
export function resourceUrlToFsPath(url: string): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (parsed.protocol !== `${RESOURCE_PROTOCOL_SCHEME}:`) return undefined
  if (parsed.hostname !== 'root') return undefined
  if (!parsed.pathname.startsWith(RESOURCE_URL_PATH_PREFIX)) return undefined

  const encoded = parsed.pathname.slice(RESOURCE_URL_PATH_PREFIX.length)
  if (!encoded) return undefined

  let decoded: string
  try {
    decoded = encoded
      .split('/')
      .map((segment) => decodeURIComponent(segment))
      .join('/')
  } catch {
    // Malformed percent-escape: not something we produced, don't guess a path.
    return undefined
  }
  return DRIVE_PATH_RE.test(decoded) ? decoded : `/${decoded}`
}
