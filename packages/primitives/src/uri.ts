/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Zero-dependency URI primitives shared by the platform kernel (`URI`) and the
 *  extension SDK (`Uri`). This module owns exactly the parts those two had
 *  verbatim in common: the component regexp, the percent codec, `file()`
 *  normalization, the path-join normalization and the `toString` / `fsPath`
 *  skeletons.
 *
 *  Everything the two deliberately disagree on stays in the callers: `$mid`,
 *  `revive` / `with` / `isUri`, strict parsing, `skipEncoding`, the drive-letter
 *  and separator policy of `fsPath`, and every error message. That is why nothing
 *  here throws and nothing here carries a platform-dependent default — a caller
 *  that needs Windows behaviour passes it in.
 *--------------------------------------------------------------------------------------------*/

const _schemePattern = /^[A-Za-z][A-Za-z0-9+.-]*$/
const _slash = '/'
const _regexp = /^(([^:/?#]+?):)?(\/\/([^/?#]*))?([^?#]*)(\?([^#]*))?(#(.*))?/

/** Structural URI parts; JSON-serializable so it crosses the host RPC verbatim. */
export interface UriComponents {
  scheme: string
  authority?: string
  path?: string
  query?: string
  fragment?: string
}

/** Whether `scheme` matches the RFC3986 scheme production. The empty string is not legal. */
export function isLegalScheme(scheme: string): boolean {
  return _schemePattern.test(scheme)
}

/**
 * Encodes a single component for use in toString. Unlike `encodeURIComponent`,
 * preserves a small set of "safe" characters that are common in paths/queries.
 *
 * Unsafe code units are encoded in whole runs rather than one `charAt(pos)` at a
 * time: `charAt` splits a surrogate pair into two lone surrogates, which
 * `encodeURIComponent` rejects with `URIError`.
 */
export function encodeURIComponentFast(text: string, allowSlash: boolean): string {
  let res: string | undefined = undefined
  let nativeEncodePos = -1
  for (let pos = 0; pos < text.length; pos++) {
    const code = text.charCodeAt(pos)
    if (
      (code >= 97 /* a */ && code <= 122) /* z */ ||
      (code >= 65 /* A */ && code <= 90) /* Z */ ||
      (code >= 48 /* 0 */ && code <= 57) /* 9 */ ||
      code === 45 /* - */ ||
      code === 46 /* . */ ||
      code === 95 /* _ */ ||
      code === 126 /* ~ */ ||
      code === 33 /* ! */ ||
      code === 36 /* $ */ ||
      code === 38 /* & */ ||
      code === 39 /* ' */ ||
      code === 40 /* ( */ ||
      code === 41 /* ) */ ||
      code === 42 /* * */ ||
      code === 43 /* + */ ||
      code === 44 /* , */ ||
      code === 59 /* ; */ ||
      code === 61 /* = */ ||
      code === 58 /* : */ ||
      code === 64 /* @ */ ||
      (allowSlash && code === 47) /* / */
    ) {
      if (nativeEncodePos !== -1) {
        if (res === undefined) res = text.substring(0, nativeEncodePos)
        res += encodeURIComponent(text.substring(nativeEncodePos, pos))
        nativeEncodePos = -1
      }
      if (res !== undefined) res += text.charAt(pos)
    } else if (nativeEncodePos === -1) {
      nativeEncodePos = pos
    }
  }
  if (nativeEncodePos !== -1) {
    if (res === undefined) res = text.substring(0, nativeEncodePos)
    res += encodeURIComponent(text.substring(nativeEncodePos))
  }
  return res ?? text
}

/** Same safe set as a query component — reuse the encoder so it lives in one place. */
export function encodeAuthority(authority: string): string {
  return encodeURIComponentFast(authority, false)
}

/** Percent-decodes, leaving the value untouched when it has no `%` or is malformed. */
export function decodeURIComponentSafe(value: string): string {
  if (!value || value.indexOf('%') === -1) return value
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * Splits a URI string into its decoded components. `undefined` is the
 * theoretical `!match` case — every group of the regexp is optional, so in
 * practice a string always matches; callers keep their own empty-result branch.
 *
 * The authority is decoded like the other components: Monaco's `Uri.toString()`
 * percent-encodes `+` there (`wsl+ubuntu2004` → `wsl%2Bubuntu2004`), and both
 * spellings have to resolve to the same URI or one file gets two identities
 * across the editor/Monaco boundary.
 */
export function parseUriComponents(value: string): Required<UriComponents> | undefined {
  const match = _regexp.exec(value)
  if (!match) return undefined
  return {
    scheme: match[2] ?? '',
    authority: decodeURIComponentSafe(match[4] ?? ''),
    path: decodeURIComponentSafe(match[5] ?? ''),
    query: decodeURIComponentSafe(match[7] ?? ''),
    fragment: decodeURIComponentSafe(match[9] ?? ''),
  }
}

/**
 * Canonical components of a `file:` URI built from an OS path: backslashes are
 * normalized to forward slashes, a UNC path puts the server into the authority
 * (`//server/share/...`), and a rooted path missing its leading slash gets one
 * (`D:/foo` → `/D:/foo`).
 */
export function normalizeFileUriPath(path: string): { authority: string; path: string } {
  let authority = ''
  let p = path.replace(/\\/g, _slash)
  if (p.startsWith('//')) {
    const idx = p.indexOf(_slash, 2)
    if (idx === -1) {
      authority = p.substring(2)
      p = _slash
    } else {
      authority = p.substring(2, idx)
      p = p.substring(idx) || _slash
    }
  } else if (!p.startsWith(_slash)) {
    p = _slash + p
  }
  return { authority, path: p }
}

/**
 * Appends path segments, then normalizes: `//` collapses, `.` and `..` resolve,
 * `..` at the root is ignored, and an emptied path falls back to `/`.
 */
export function joinUriPath(basePath: string, segments: readonly string[]): string {
  let result = basePath
  for (const seg of segments) {
    if (!seg) continue
    if (result.endsWith(_slash)) {
      result += seg.startsWith(_slash) ? seg.substring(1) : seg
    } else {
      result += seg.startsWith(_slash) ? seg : _slash + seg
    }
  }
  // Normalize: collapse `//`, resolve `.` and `..`.
  const parts = result.split(_slash)
  const out: string[] = []
  for (const part of parts) {
    if (part === '' || part === '.') {
      if (out.length === 0) out.push(part)
      continue
    }
    if (part === '..') {
      if (out.length > 1 && out[out.length - 1] !== '..') {
        out.pop()
      } else if (out.length === 1 && out[0] === '') {
        // root: ignore ../
      } else {
        out.push(part)
      }
      continue
    }
    out.push(part)
  }
  return out.join(_slash) || _slash
}

/** Component encoder for {@link formatUri}: `allowSlash` is true for the path only. */
export type UriComponentEncoder = (text: string, allowSlash: boolean) => string

/**
 * The `toString` skeleton. `encodeComponent` covers path / query / fragment;
 * the authority always goes through {@link encodeAuthority}, in every mode —
 * including the SDK's `skipEncoding`, which therefore only relaxes the other
 * three components.
 */
export function formatUri(uri: UriComponents, encodeComponent: UriComponentEncoder): string {
  const { scheme, authority, path, query, fragment } = uri
  let res = ''
  if (scheme) {
    res += scheme
    res += ':'
  }
  if (authority || scheme === 'file') {
    res += _slash
    res += _slash
  }
  if (authority) {
    res += encodeAuthority(authority)
  }
  if (path) {
    res += encodeComponent(path, true)
  }
  if (query) {
    res += '?'
    res += encodeComponent(query, false)
  }
  if (fragment) {
    res += '#'
    res += encodeComponent(fragment, false)
  }
  return res
}

/**
 * How a caller turns a URI into a filesystem path. Both flags are required: the
 * kernel wants neither (it keeps `D:/foo` and forward slashes on every host),
 * the SDK wants both on Windows (`c:/foo` → `c:\foo`). Neither behaviour is a
 * default of this module.
 */
export interface UriToFsPathOptions {
  /** Replace every `/` with `\` (Windows native form). */
  nativeSeparators: boolean
  /** Lower-case the drive letter of a drive path (`/C:/x` → `c:/x`). */
  lowercaseDriveLetter: boolean
}

/**
 * The `fsPath` skeleton: a `file:` URI carrying an authority and a non-root path
 * folds it back into `//authority/path`; a `/X:/…` path drops the leading slash
 * (optionally folding the drive letter); anything else passes through.
 */
export function uriToFsPath(uri: UriComponents, options: UriToFsPathOptions): string {
  const path = uri.path ?? ''
  let value: string
  if (uri.authority && path.length > 1 && uri.scheme === 'file') {
    value = `//${uri.authority}${path}`
  } else if (
    path.charCodeAt(0) === 47 /* / */ &&
    ((path.charCodeAt(1) >= 65 /* A */ && path.charCodeAt(1) <= 90) /* Z */ ||
      (path.charCodeAt(1) >= 97 /* a */ && path.charCodeAt(1) <= 122)) /* z */ &&
    path.charCodeAt(2) === 58 /* : */
  ) {
    value = options.lowercaseDriveLetter
      ? path.charAt(1).toLowerCase() + path.substring(2)
      : path.substring(1)
  } else {
    value = path
  }
  return options.nativeSeparators ? value.replace(/\//g, '\\') : value
}
