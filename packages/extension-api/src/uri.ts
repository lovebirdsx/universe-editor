/**
 * `Uri` — an immutable uniform resource identifier, the extension-facing
 * counterpart of the platform's URI (same canonical shapes, so values round-trip
 * across the RPC boundary): `Uri.file('C:\\x\\y').path` is the canonical
 * `/C:/x/y` form (leading slash before the drive letter). Instances are created
 * through the static factories (`file` / `parse` / `from` / `joinPath`).
 *
 * The percent codec, `file()` normalization, the path-join normalization and the
 * toString / fsPath skeletons live in `@universe-editor/primitives`, shared with
 * the kernel. What stays here is the `vscode.d.ts` surface this package promises:
 * `parse(value, strict)`, `toString(skipEncoding)`, `from()` requiring a scheme,
 * and the SDK's own filesystem-path policy (drive letter lower-cased, native
 * separators on Windows — the platform's `fsPath` does neither).
 */

import {
  encodeURIComponentFast,
  formatUri,
  isLegalScheme,
  joinUriPath,
  normalizeFileUriPath,
  parseUriComponents,
  uriToFsPath,
} from '@universe-editor/primitives'
import type { UriComponents } from '@universe-editor/primitives'

const _empty = ''

const _isWindows = typeof process === 'object' && process.platform === 'win32'

export type { UriComponents }

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
    const { authority, path: uriPath } = normalizeFileUriPath(path)
    return new Uri('file', authority, uriPath, _empty, _empty)
  }

  /**
   * Parse a URI string; percent-encoded sequences are decoded. With `strict`,
   * a missing or illegal scheme throws instead of producing an empty Uri.
   */
  static parse(value: string, strict?: boolean): Uri {
    const components = parseUriComponents(value)
    if (!components) {
      if (strict) throw new Error(`[UriError]: not a well-formed URI: "${value}"`)
      return new Uri(_empty, _empty, _empty, _empty, _empty)
    }
    if (strict && !isLegalScheme(components.scheme)) {
      throw new Error(`[UriError]: scheme is missing or illegal in "${value}"`)
    }
    return new Uri(
      components.scheme,
      components.authority,
      components.path,
      components.query,
      components.fragment,
    )
  }

  /** Build a Uri from its components. The scheme is required and must be legal. */
  static from(components: UriComponents): Uri {
    if (!components.scheme || !isLegalScheme(components.scheme)) {
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
      joinUriPath(base.path, pathSegments),
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
    return uriToFsPath(this, { nativeSeparators: _isWindows, lowercaseDriveLetter: true })
  }

  /**
   * The string form. By default components are percent-encoded (spaces, `#`,
   * `?`, …); `skipEncoding` leaves them untouched except the two delimiter
   * characters — pass it when the components are already encoded.
   */
  toString(skipEncoding?: boolean): string {
    return formatUri(
      this,
      skipEncoding === true ? encodeURIComponentMinimal : encodeURIComponentFast,
    )
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
