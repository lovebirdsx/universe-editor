/**
 * `Uri` — an immutable uniform resource identifier, the extension-facing
 * counterpart of the platform's URI (same canonical shapes, so values round-trip
 * across the RPC boundary): `Uri.file('C:\\x\\y').path` is the canonical
 * `/C:/x/y` form (leading slash before the drive letter). Instances are created
 * through the static factories (`file` / `parse` / `from` / `joinPath`).
 */

/** Structural URI parts; JSON-serializable so it crosses the host RPC verbatim. */
export interface UriComponents {
  scheme: string
  authority?: string
  path?: string
  query?: string
  fragment?: string
}

const _schemePattern = /^[A-Za-z][A-Za-z0-9+.-]*$/
const _empty = ''
const _slash = '/'
const _regexp = /^(([^:/?#]+?):)?(\/\/([^/?#]*))?([^?#]*)(\?([^#]*))?(#(.*))?/

const _isWindows = typeof process === 'object' && process.platform === 'win32'

function decodeURIComponentSafe(value: string): string {
  if (!value || value.indexOf('%') === -1) return value
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * Encodes a single component for use in toString. Unlike `encodeURIComponent`,
 * preserves a small set of "safe" characters that are common in paths/queries.
 */
function encodeURIComponentFast(text: string, allowSlash: boolean): string {
  let res: string | undefined = undefined
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
      if (res !== undefined) res += text.charAt(pos)
    } else {
      if (res === undefined) res = text.substring(0, pos)
      res += encodeURIComponent(text.charAt(pos))
    }
  }
  return res ?? text
}

function encodeAuthority(authority: string): string {
  return authority.replace(/[^A-Za-z0-9-._~!$&'()*+,;=:@]/g, (c) => encodeURIComponent(c))
}

/**
 * The skipEncoding form: only `#` and `?` are encoded (they would re-parse as
 * component delimiters); everything else — spaces, existing `%XX` sequences —
 * passes through untouched.
 */
function encodeURIComponentMinimal(text: string): string {
  let res: string | undefined = undefined
  for (let pos = 0; pos < text.length; pos++) {
    const code = text.charCodeAt(pos)
    if (code === 35 /* # */ || code === 63 /* ? */) {
      if (res === undefined) res = text.substring(0, pos)
      res += encodeURIComponent(text.charAt(pos))
    } else if (res !== undefined) {
      res += text.charAt(pos)
    }
  }
  return res ?? text
}

function joinPaths(basePath: string, segments: readonly string[]): string {
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

function uriToString(uri: Uri, skipEncoding: boolean): string {
  const { scheme, authority, path, query, fragment } = uri
  const encode = skipEncoding
    ? encodeURIComponentMinimal
    : (text: string, allowSlash: boolean) => encodeURIComponentFast(text, allowSlash)
  let res = _empty
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
    res += encode(path, true)
  }
  if (query) {
    res += '?'
    res += encode(query, false)
  }
  if (fragment) {
    res += '#'
    res += encode(fragment, false)
  }
  return res
}

export class Uri implements UriComponents {
  readonly scheme: string
  readonly authority: string
  readonly path: string
  readonly query: string
  readonly fragment: string

  private constructor(
    scheme: string,
    authority: string,
    path: string,
    query: string,
    fragment: string,
  ) {
    this.scheme = scheme
    this.authority = authority
    this.path = path
    this.query = query
    this.fragment = fragment
  }

  /**
   * Construct a `file:` URI from an OS path; backslashes are normalized to
   * forward slashes. A Windows drive path (`D:\foo` / `D:/foo`) gets the
   * canonical leading slash (`/D:/foo`); a UNC path puts the server into the
   * authority (`file://server/share/...`).
   */
  static file(path: string): Uri {
    let authority = _empty
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
    return new Uri('file', authority, p, _empty, _empty)
  }

  /**
   * Parse a URI string; percent-encoded sequences are decoded. With `strict`,
   * a missing or illegal scheme throws instead of producing an empty Uri.
   */
  static parse(value: string, strict?: boolean): Uri {
    const match = _regexp.exec(value)
    if (!match) {
      if (strict) throw new Error(`[UriError]: not a well-formed URI: "${value}"`)
      return new Uri(_empty, _empty, _empty, _empty, _empty)
    }
    const scheme = match[2] ?? _empty
    if (strict && !_schemePattern.test(scheme)) {
      throw new Error(`[UriError]: scheme is missing or illegal in "${value}"`)
    }
    return new Uri(
      scheme,
      decodeURIComponentSafe(match[4] ?? _empty),
      decodeURIComponentSafe(match[5] ?? _empty),
      decodeURIComponentSafe(match[7] ?? _empty),
      decodeURIComponentSafe(match[9] ?? _empty),
    )
  }

  /** Build a Uri from its components. The scheme is required and must be legal. */
  static from(components: UriComponents): Uri {
    if (!components.scheme || !_schemePattern.test(components.scheme)) {
      throw new Error(`[UriError]: scheme is missing or illegal: "${components.scheme}"`)
    }
    return new Uri(
      components.scheme,
      components.authority ?? _empty,
      components.path ?? _empty,
      components.query ?? _empty,
      components.fragment ?? _empty,
    )
  }

  /**
   * Append path segments to `base`. Segments join with `/` and the result is
   * normalized (`//` collapsed, `.` / `..` resolved).
   */
  static joinPath(base: Uri, ...pathSegments: string[]): Uri {
    if (!base.path) {
      throw new Error('[UriError]: cannot call joinPath on a URI without a path')
    }
    return new Uri(
      base.scheme,
      base.authority,
      joinPaths(base.path, pathSegments),
      base.query,
      base.fragment,
    )
  }

  /**
   * Filesystem path form of a `file:` URI: `file:///c:/x` → `c:\x` (drive letter
   * lower-cased), `file://server/share/x` → `\\server\share\x`. Backslash
   * separators on Windows, forward slashes elsewhere.
   */
  get fsPath(): string {
    let value: string
    if (this.authority && this.path.length > 1 && this.scheme === 'file') {
      value = `//${this.authority}${this.path}`
    } else if (
      this.path.charCodeAt(0) === 47 /* / */ &&
      ((this.path.charCodeAt(1) >= 65 /* A */ && this.path.charCodeAt(1) <= 90) /* Z */ ||
        (this.path.charCodeAt(1) >= 97 /* a */ && this.path.charCodeAt(1) <= 122)) /* z */ &&
      this.path.charCodeAt(2) === 58 /* : */
    ) {
      // Windows drive letter: `/c:/x` → `c:/x`.
      value = this.path.charAt(1).toLowerCase() + this.path.substring(2)
    } else {
      value = this.path
    }
    return _isWindows ? value.replace(/\//g, '\\') : value
  }

  /**
   * The string form. By default components are percent-encoded (spaces, `#`,
   * `?`, …); `skipEncoding` leaves them untouched except the two delimiter
   * characters — pass it when the components are already encoded.
   */
  toString(skipEncoding?: boolean): string {
    return uriToString(this, skipEncoding === true)
  }

  /** JSON form for persistence/RPC, carrying only the non-empty components. */
  toJSON(): UriComponents {
    return {
      scheme: this.scheme,
      ...(this.authority ? { authority: this.authority } : {}),
      ...(this.path ? { path: this.path } : {}),
      ...(this.query ? { query: this.query } : {}),
      ...(this.fragment ? { fragment: this.fragment } : {}),
    }
  }
}
