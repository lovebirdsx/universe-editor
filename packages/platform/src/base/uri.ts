/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Kernel URI — the platform's resource identity type.
 *
 *  The percent codec, the component regexp, `file()` normalization, the path-join
 *  normalization and the toString / fsPath skeletons live in
 *  `@universe-editor/primitives`, shared with the extension SDK's `Uri`. What stays
 *  here is everything kernel-specific:
 *   - `$mid` / `revive` / `with` / `isUri`
 *   - the platform-aware comparison-key family (`getResourceComparisonKey` et al.)
 *   - the policy that `fsPath` never re-writes separators or the drive-letter case
 *
 *  Adapted from Microsoft VSCode (`vs/base/common/uri.ts`).
 *--------------------------------------------------------------------------------------------*/

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
import { isCaseInsensitive, normalizeFsPath } from './path.js'
import type { HostPlatform } from '../host/hostService.js'

const _empty = ''

export type { UriComponents }

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

  /**
   * Filesystem path representation. For `file:` URIs this is the absolute path.
   *
   * Kernel policy: the drive letter keeps its case and separators stay forward
   * slashes on every host — a resource reaching the kernel may be served by a
   * remote provider, so the local platform must not leak into it. Path identity
   * goes through {@link getResourceComparisonKey} instead (and the `.fsPath`
   * ESLint rule keeps the kernel off this getter anyway).
   */
  get fsPath(): string {
    return uriToFsPath(this, { nativeSeparators: false, lowercaseDriveLetter: false })
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
    return formatUri(this, encodeURIComponentFast)
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
    const components = parseUriComponents(value)
    if (!components) {
      return new URI(_empty, _empty, _empty, _empty, _empty)
    }
    return new URI(
      components.scheme,
      components.authority,
      components.path,
      components.query,
      components.fragment,
    )
  }

  /** Build a URI from its components. Unlike the SDK's `Uri.from`, the scheme is optional. */
  static from(components: UriComponents): URI {
    if (components.scheme && !isLegalScheme(components.scheme)) {
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
    const { authority, path: uriPath } = normalizeFileUriPath(path)
    return new URI('file', authority, uriPath, _empty, _empty)
  }

  /**
   * Append path segments to the base URI. Segments are joined with `/` and
   * the result is normalised (collapsing `//` and resolving `.` / `..`).
   *
   * Deriving through {@link URI.with} is deliberate: an unchanged path returns the
   * same instance, which callers rely on (`with` is the single derivation point).
   */
  static joinPath(base: URI, ...pathFragment: string[]): URI {
    if (!base.path) {
      throw new Error('[UriError]: cannot call joinPath on URI without path')
    }
    const joined = joinUriPath(base.path, pathFragment)
    return base.with({ path: joined })
  }

  /** Revive a value produced by `toJSON` back into a URI instance. */
  static revive(data: UriComponents | URI | null | undefined): URI | null | undefined {
    if (!data) return data as null | undefined
    if (data instanceof URI) return data
    return URI.from(data)
  }
}

/**
 * Resolves whether the filesystem backing `uri` compares paths case-sensitively.
 * Return `undefined` to fall back to the host platform's policy.
 *
 * Case sensitivity is a property of the filesystem, not of the machine running
 * the UI: a `file:` resource follows the local platform, but a resource served
 * by another provider (e.g. a Linux host reached over a remote connection)
 * follows *that* filesystem. `IUriIdentityService` builds one of these from its
 * per-scheme registry.
 */
export type CaseSensitivityResolver = (uri: URI) => boolean | undefined

/**
 * A platform-aware comparison key for a resource. Two URIs that address the same
 * resource — accounting for path separators, redundant `.`/`..` segments,
 * Windows drive-letter case, and (on win32/darwin) path case — collapse to the
 * same key. On linux the path is compared case-sensitively.
 *
 * This is the single identity function for resources: {@link ResourceMap} /
 * {@link ResourceSet} use it as their hash key, and {@link isEqualResource} /
 * {@link isEqualOrParentResource} are defined in terms of it, so map de-dup and
 * equality never disagree. Prefer `IUriIdentityService` (which injects the
 * platform once) over calling this directly.
 *
 * `caseSensitivity` overrides the platform policy per resource — pass it when
 * the URI may be served by a provider whose filesystem differs from the local
 * one. Omitting it keeps the pure host-platform behaviour.
 *
 * Only `file:` URIs get filesystem normalization; other schemes fall back to
 * `toString()` with the path lower-cased on case-insensitive platforms.
 */
export function getResourceComparisonKey(
  uri: URI,
  platform: HostPlatform,
  caseSensitivity?: CaseSensitivityResolver,
): string {
  const ci = resolveCaseInsensitive(uri, platform, caseSensitivity)
  if (uri.scheme === 'file') {
    // Normalize the path (folds separators, drive-letter case and `.`/`..`), and
    // keep the authority separately so `file://a` and `file://b` — or two distinct
    // UNC hosts — never collide. Going through `fsPath` would drop an authority
    // whenever the path is empty, silently merging those. Lower-case the whole key
    // on case-insensitive platforms so `Foo.ts` and `foo.ts` match there, not on linux.
    const norm = normalizeFsPath(pathWithoutAuthority(uri))
    const key = uri.authority ? `//${uri.authority}${norm}` : norm
    return ci ? key.toLowerCase() : key
  }
  const key = uri.toString()
  return ci ? key.toLowerCase() : key
}

function resolveCaseInsensitive(
  uri: URI,
  platform: HostPlatform,
  caseSensitivity: CaseSensitivityResolver | undefined,
): boolean {
  const sensitive = caseSensitivity?.(uri)
  return sensitive === undefined ? isCaseInsensitive(platform) : !sensitive
}

/**
 * The local-path portion of a `file:` URI, independent of its authority.
 * Strips the leading slash before a Windows drive (`/D:/x` → `D:/x`) so
 * {@link normalizeFsPath} can fold the drive-letter case, but — unlike
 * {@link URI.fsPath} — never folds the authority into the path, so
 * {@link getResourceComparisonKey} can keep hosts distinct.
 */
function pathWithoutAuthority(uri: URI): string {
  const p = uri.path
  if (
    p.charCodeAt(0) === 47 /* / */ &&
    ((p.charCodeAt(1) >= 65 /* A */ && p.charCodeAt(1) <= 90) /* Z */ ||
      (p.charCodeAt(1) >= 97 /* a */ && p.charCodeAt(1) <= 122)) /* z */ &&
    p.charCodeAt(2) === 58 /* : */
  ) {
    return p.substr(1)
  }
  return p
}

/**
 * The canonical text form of a local `file:` URI: the Windows drive letter is
 * folded to upper case — the same direction as {@link normalizeFsPath} — so a
 * folder has one spelling no matter who produced it. Without a shared fold the
 * folder dialog's casing, the Explorer's own normalization and a hand-typed
 * path are three different strings for one file, and every `toString()`
 * comparison downstream (dedup keys, workspace storage buckets, tree-state
 * keys, window lookup) silently forks.
 *
 * UNC paths (`file://host/…`), non-`file:` schemes and paths without a drive
 * letter are returned unchanged; an already-canonical URI is returned as the
 * same instance.
 */
export function canonicalizeFileUri(uri: URI): URI {
  if (uri.scheme !== 'file') return uri
  const path = uri.path.replace(/^\/([a-z]):/, (_, drive: string) => `/${drive.toUpperCase()}:`)
  return path === uri.path ? uri : uri.with({ path })
}

/** Whether two URIs address the same resource under the platform's case policy
 *  (see {@link getResourceComparisonKey}). */
export function isEqualResource(
  a: URI | undefined,
  b: URI | undefined,
  platform: HostPlatform,
  caseSensitivity?: CaseSensitivityResolver,
): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (
    getResourceComparisonKey(a, platform, caseSensitivity) ===
    getResourceComparisonKey(b, platform, caseSensitivity)
  )
}

/** Whether `resource` is equal to, or nested under, `parent` (both `file:` URIs)
 *  under the platform's case policy. Non-file schemes fall back to key equality. */
export function isEqualOrParentResource(
  resource: URI | undefined,
  parent: URI | undefined,
  platform: HostPlatform,
  caseSensitivity?: CaseSensitivityResolver,
): boolean {
  if (!resource || !parent) return false
  if (resource === parent) return true
  const rKey = getResourceComparisonKey(resource, platform, caseSensitivity)
  const pKey = getResourceComparisonKey(parent, platform, caseSensitivity)
  if (rKey === pKey) return true
  if (resource.scheme !== parent.scheme || resource.authority !== parent.authority) return false
  // Boundary-aware containment: `/a/b` is a parent of `/a/b/c` but not of `/a/bc`.
  const pWithSep = pKey.endsWith('/') ? pKey : pKey + '/'
  return rKey.startsWith(pWithSep)
}
