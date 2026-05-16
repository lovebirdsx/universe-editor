/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Simplified URI implementation.
 *
 *  Adapted from Microsoft VSCode (`vs/base/common/uri.ts`) — restricted to the
 *  features universe-editor needs:
 *   - parse / from / file / joinPath constructors
 *   - immutable instances with `with(change)`
 *   - toString / fsPath getters
 *   - toJSON / revive for persistence
 *
 *  Out of scope (vs. VSCode):
 *   - UNC paths
 *   - Strict mode validation throwing on malformed components
 *   - Cached toString variants behind length thresholds
 *--------------------------------------------------------------------------------------------*/

const _schemePattern = /^[A-Za-z][A-Za-z0-9+.-]*$/
const _empty = ''
const _slash = '/'
const _regexp = /^(([^:/?#]+?):)?(\/\/([^/?#]*))?([^?#]*)(\?([^#]*))?(#(.*))?/

export interface UriComponents {
  scheme: string
  authority?: string
  path?: string
  query?: string
  fragment?: string
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
      if (res === undefined) res = text.substr(0, pos)
      res += encodeURIComponent(text.charAt(pos))
    }
  }
  return res ?? text
}

function encodeAuthority(authority: string): string {
  return authority.replace(/[^A-Za-z0-9-._~!$&'()*+,;=:@]/g, (c) => encodeURIComponent(c))
}

/**
 * Universal Resource Identifier - simplified port of VSCode's URI.
 *
 * Instances are immutable. Use {@link URI.with} to derive new variants.
 */
export class URI implements UriComponents {
  static isUri(thing: unknown): thing is URI {
    if (thing instanceof URI) return true
    if (!thing || typeof thing !== 'object') return false
    const c = thing as UriComponents
    return (
      typeof c.scheme === 'string' && (c.authority === undefined || typeof c.authority === 'string')
    )
  }

  readonly scheme: string
  readonly authority: string
  readonly path: string
  readonly query: string
  readonly fragment: string

  protected constructor(
    scheme: string,
    authority?: string,
    path?: string,
    query?: string,
    fragment?: string,
  ) {
    this.scheme = scheme || _empty
    this.authority = authority || _empty
    this.path = path || _empty
    this.query = query || _empty
    this.fragment = fragment || _empty
  }

  /** Filesystem path representation. For `file:` URIs this is the absolute path. */
  get fsPath(): string {
    return _uriToFsPath(this)
  }

  with(change: {
    scheme?: string
    authority?: string | null
    path?: string | null
    query?: string | null
    fragment?: string | null
  }): URI {
    if (!change) return this
    let { scheme, authority, path, query, fragment } = change
    if (scheme === undefined) scheme = this.scheme
    else if (scheme === null) scheme = _empty
    if (authority === undefined) authority = this.authority
    else if (authority === null) authority = _empty
    if (path === undefined) path = this.path
    else if (path === null) path = _empty
    if (query === undefined) query = this.query
    else if (query === null) query = _empty
    if (fragment === undefined) fragment = this.fragment
    else if (fragment === null) fragment = _empty

    if (
      scheme === this.scheme &&
      authority === this.authority &&
      path === this.path &&
      query === this.query &&
      fragment === this.fragment
    ) {
      return this
    }
    return new URI(scheme, authority, path, query, fragment)
  }

  toString(): string {
    return _toString(this)
  }

  toJSON(): UriComponents & { $mid: 1 } {
    return {
      $mid: 1,
      scheme: this.scheme,
      ...(this.authority ? { authority: this.authority } : {}),
      ...(this.path ? { path: this.path } : {}),
      ...(this.query ? { query: this.query } : {}),
      ...(this.fragment ? { fragment: this.fragment } : {}),
    }
  }

  /** Parse a string into a URI. */
  static parse(value: string): URI {
    const match = _regexp.exec(value)
    if (!match) {
      return new URI(_empty, _empty, _empty, _empty, _empty)
    }
    const scheme = match[2] ?? _empty
    const authority = match[4] ?? _empty
    let path = match[5] ?? _empty
    const query = decodeURIComponentSafe(match[7] ?? _empty)
    const fragment = decodeURIComponentSafe(match[9] ?? _empty)
    path = decodeURIComponentSafe(path)
    return new URI(scheme, authority, path, query, fragment)
  }

  /** Build a URI from its components. */
  static from(components: UriComponents): URI {
    if (components.scheme && !_schemePattern.test(components.scheme)) {
      throw new Error(`[UriError]: Scheme contains illegal characters: "${components.scheme}"`)
    }
    return new URI(
      components.scheme,
      components.authority,
      components.path,
      components.query,
      components.fragment,
    )
  }

  /**
   * Construct a `file:` URI from an OS path. Accepts forward or back slashes.
   * Windows drive paths (e.g. `D:/foo` / `D:\foo`) become `file:///D:/foo`.
   */
  static file(path: string): URI {
    let authority = _empty
    // Normalise path separators to forward slash.
    let p = path.replace(/\\/g, _slash)
    // UNC paths -> //server/share/...
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
      // Absolute-from-root: prepend a slash so `D:/foo` -> `/D:/foo`.
      p = _slash + p
    }
    return new URI('file', authority, p, _empty, _empty)
  }

  /**
   * Append path segments to the base URI. Segments are joined with `/` and
   * the result is normalised (collapsing `//` and resolving `.` / `..`).
   */
  static joinPath(base: URI, ...pathFragment: string[]): URI {
    if (!base.path) {
      throw new Error('[UriError]: cannot call joinPath on URI without path')
    }
    const joined = _joinPath(base.path, pathFragment)
    return base.with({ path: joined })
  }

  /** Revive a value produced by `toJSON` back into a URI instance. */
  static revive(data: UriComponents | URI | null | undefined): URI | null | undefined {
    if (!data) return data as null | undefined
    if (data instanceof URI) return data
    return URI.from(data)
  }
}

function decodeURIComponentSafe(value: string): string {
  if (!value || value.indexOf('%') === -1) return value
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function _toString(uri: URI): string {
  const { scheme, authority, path, query, fragment } = uri
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
    res += encodeURIComponentFast(path, true)
  }
  if (query) {
    res += '?'
    res += encodeURIComponentFast(query, false)
  }
  if (fragment) {
    res += '#'
    res += encodeURIComponentFast(fragment, false)
  }
  return res
}

function _uriToFsPath(uri: URI): string {
  let value: string
  if (uri.authority && uri.path.length > 1 && uri.scheme === 'file') {
    value = `//${uri.authority}${uri.path}`
  } else if (
    uri.path.charCodeAt(0) === 47 /* / */ &&
    ((uri.path.charCodeAt(1) >= 65 /* A */ && uri.path.charCodeAt(1) <= 90) /* Z */ ||
      (uri.path.charCodeAt(1) >= 97 /* a */ && uri.path.charCodeAt(1) <= 122)) /* z */ &&
    uri.path.charCodeAt(2) === 58 /* : */
  ) {
    value = uri.path.substr(1)
  } else {
    value = uri.path
  }
  return value
}

function _joinPath(basePath: string, segments: string[]): string {
  let result = basePath
  for (const seg of segments) {
    if (!seg) continue
    if (result.endsWith(_slash)) {
      result += seg.startsWith(_slash) ? seg.substring(1) : seg
    } else {
      result += seg.startsWith(_slash) ? seg : _slash + seg
    }
  }
  // Normalise: collapse `//`, resolve `.` and `..`.
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
