/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Text-level filesystem path helpers (no fs lookup, no Node `path`).
 *
 *  Intentionally string-only so renderer code — which lacks synchronous fs
 *  primitives — can normalize and compare paths cheaply and deterministically
 *  across platforms.
 *--------------------------------------------------------------------------------------------*/

import type { HostPlatform } from '../host/hostService.js'

const ESCAPED_PREFIX = '__ESCAPED__'

function toForwardSlashes(p: string): string {
  return p.replace(/\\/g, '/')
}

function stripTrailingSlash(p: string): string {
  if (p.length <= 1) return p
  return p.endsWith('/') ? p.slice(0, -1) : p
}

/**
 * Text-level absolute path normalization:
 * - backslash → forward slash
 * - uppercase Windows drive letter (e.g. `d:/foo` → `D:/foo`)
 * - collapse `.` and `..` segments
 * - strip trailing slash (except a bare root)
 *
 * Returns a string prefixed with `__ESCAPED__` when `..` would escape the
 * filesystem root — callers should treat such results as invalid.
 */
export function normalizeFsPath(p: string): string {
  const fwd = toForwardSlashes(p)
  const isAbsPosix = fwd.startsWith('/')
  const driveMatch = /^([a-zA-Z]):\//.exec(fwd)
  const drive = driveMatch ? driveMatch[1]!.toUpperCase() + ':' : ''
  const rest = driveMatch ? fwd.slice(driveMatch[0].length - 1) : fwd
  const parts = rest.split('/').filter((s) => s.length > 0 && s !== '.')
  const out: string[] = []
  let escaped = false
  for (const seg of parts) {
    if (seg === '..') {
      if (out.length === 0) {
        escaped = true
        continue
      }
      out.pop()
    } else {
      out.push(seg)
    }
  }
  const prefix = drive ? drive + '/' : isAbsPosix ? '/' : ''
  const joined = prefix + out.join('/')
  return stripTrailingSlash((escaped ? ESCAPED_PREFIX : '') + joined)
}

/**
 * Whether the given host platform treats filesystem paths case-insensitively.
 * win32/darwin fold case; linux (and unknown) are case-sensitive. This is the
 * single source of truth for the case policy — the URI comparison-key layer
 * ({@link getResourceComparisonKey}) reuses it so string-path and URI equality
 * never diverge.
 */
export function isCaseInsensitive(platform: HostPlatform): boolean {
  return platform === 'win32' || platform === 'darwin'
}

/**
 * Platform-aware equality of two absolute filesystem paths. Both inputs are
 * normalized first (backslashes, drive case, `.`/`..`), then compared with
 * `toLowerCase` on win32/darwin and case-sensitively on linux/unknown.
 *
 * Returns `false` for `undefined`, empty strings, or normalize results that
 * carry the `__ESCAPED__` prefix — even if both sides look "equal" — so a
 * caller cannot accidentally treat two missing cwds as the same workspace.
 */
export function arePathsEqual(
  a: string | undefined,
  b: string | undefined,
  platform: HostPlatform,
): boolean {
  if (!a || !b) return false
  const na = normalizeFsPath(a)
  const nb = normalizeFsPath(b)
  if (na.startsWith(ESCAPED_PREFIX) || nb.startsWith(ESCAPED_PREFIX)) return false
  if (isCaseInsensitive(platform)) return na.toLowerCase() === nb.toLowerCase()
  return na === nb
}

/**
 * A stable comparison key for an absolute filesystem path string, usable as a
 * `Map`/`Set` key. Two paths that {@link arePathsEqual} produce the same key,
 * and two that don't produce different keys — same normalize + case policy, so a
 * keyed collection never disagrees with a pairwise comparison. Prefer
 * `IUriIdentityService.getPathComparisonKey` over calling this directly.
 *
 * Unlike `arePathsEqual`, this keeps working for a path that escapes the root
 * (the `__ESCAPED__` marker is retained, folded like any other segment) so a
 * caller building a key never silently collapses distinct escaped paths.
 */
export function getPathComparisonKey(path: string, platform: HostPlatform): string {
  const norm = normalizeFsPath(path)
  return isCaseInsensitive(platform) ? norm.toLowerCase() : norm
}

/**
 * The OS-native path separator for `${pathSeparator}` style substitution:
 * backslash on win32, forward slash elsewhere. Note this is deliberately the
 * *display* separator — the helpers below all emit forward slashes internally,
 * matching how {@link URI.fsPath} represents paths across the codebase.
 */
export function pathSeparator(platform: HostPlatform): string {
  return platform === 'win32' ? '\\' : '/'
}

/** Uppercase a leading Windows drive letter (`d:/foo` → `D:/foo`); other paths unchanged. */
export function normalizeDriveLetter(p: string): string {
  return /^[a-z]:/.test(p) ? p.charAt(0).toUpperCase() + p.slice(1) : p
}

/**
 * Whether `p` is an absolute path for the given platform. win32 accepts a drive
 * root (`C:/`, `C:\`), a bare rooted path (`/foo`) and UNC (`//host`); other
 * platforms accept only a leading slash. Backslashes are treated as separators.
 */
export function isAbsolutePath(p: string, platform: HostPlatform): boolean {
  if (p.length === 0) return false
  const fwd = toForwardSlashes(p)
  if (fwd.charCodeAt(0) === 47 /* / */) return true
  return platform === 'win32' && /^[a-zA-Z]:\//.test(fwd)
}

/**
 * Join path segments with forward slashes. Empty segments are skipped; interior
 * duplicate slashes are collapsed. The result is *not* `.`/`..`-collapsed — run
 * it through {@link normalizeFsPath} if you need that. Mirrors the subset of
 * Node `path.join` the variable resolver needs (no platform-native separators).
 */
export function joinPath(...segments: readonly string[]): string {
  const parts: string[] = []
  for (const seg of segments) {
    if (seg.length === 0) continue
    parts.push(toForwardSlashes(seg))
  }
  if (parts.length === 0) return '.'
  return parts.join('/').replace(/(?<!:)\/{2,}/g, '/')
}

/** Last path segment (`/a/b/c.ts` → `c.ts`). Trailing slashes are ignored. */
export function basename(p: string): string {
  const fwd = stripTrailingSlash(toForwardSlashes(p))
  const slash = fwd.lastIndexOf('/')
  return slash === -1 ? fwd : fwd.slice(slash + 1)
}

/**
 * Directory portion (`/a/b/c.ts` → `/a/b`). Returns `.` for a bare name and
 * preserves a drive/absolute root when the parent collapses to it.
 */
export function dirname(p: string): string {
  const fwd = stripTrailingSlash(toForwardSlashes(p))
  const slash = fwd.lastIndexOf('/')
  if (slash === -1) return '.'
  if (slash === 0) return '/'
  // Keep the drive root, e.g. `C:/foo` → `C:/`.
  if (/^[a-zA-Z]:$/.test(fwd.slice(0, slash))) return fwd.slice(0, slash + 1)
  return fwd.slice(0, slash)
}

/** File extension including the dot (`c.ts` → `.ts`); `''` when none. */
export function extname(p: string): string {
  const base = basename(p)
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot)
}

/**
 * Relative path from `from` to `to` (both absolute), platform-aware. May climb
 * with `..` segments. Returns the {@link normalizeFsPath}-collapsed `to` when
 * the two live on different Windows drives (no relative path exists). Mirrors the
 * subset of Node `path.relative` the variable resolver needs.
 */
export function relativePath(from: string, to: string, platform: HostPlatform): string {
  const nf = normalizeFsPath(from)
  const nt = normalizeFsPath(to)
  if (nf.startsWith(ESCAPED_PREFIX) || nt.startsWith(ESCAPED_PREFIX)) return nt
  const ci = isCaseInsensitive(platform)
  const fromParts = nf.split('/').filter((s) => s.length > 0)
  const toParts = nt.split('/').filter((s) => s.length > 0)
  const eq = (a: string, b: string) => (ci ? a.toLowerCase() === b.toLowerCase() : a === b)
  // Different roots (e.g. distinct Windows drives) — no relative path.
  if (fromParts.length > 0 && toParts.length > 0 && !eq(fromParts[0]!, toParts[0]!)) {
    if (/^[a-zA-Z]:$/.test(fromParts[0]!) || /^[a-zA-Z]:$/.test(toParts[0]!)) return nt
  }
  let i = 0
  while (i < fromParts.length && i < toParts.length && eq(fromParts[i]!, toParts[i]!)) i++
  const up = fromParts.slice(i).map(() => '..')
  const down = toParts.slice(i)
  const out = [...up, ...down]
  return out.length === 0 ? '' : out.join('/')
}

/**
 * If `child` resolves under `parent`, return the relative path (`''` when
 * equal). Returns `null` when:
 *   - either input is empty or normalizes to an escaped result,
 *   - the two paths are on different Windows drives,
 *   - `child` is not contained in `parent`.
 *
 * Platform-aware: case-insensitive on win32/darwin, case-sensitive elsewhere.
 * The returned relative path preserves the original casing from `child`
 * (only the comparison is case-folded, not the result).
 */
export function relativePathUnder(
  parent: string,
  child: string,
  platform: HostPlatform,
): string | null {
  if (!parent || !child) return null
  const r = normalizeFsPath(parent)
  const t = normalizeFsPath(child)
  if (r.startsWith(ESCAPED_PREFIX) || t.startsWith(ESCAPED_PREFIX)) return null
  const rDrive = /^([a-zA-Z]):/.exec(r)?.[1]?.toUpperCase() ?? ''
  const tDrive = /^([a-zA-Z]):/.exec(t)?.[1]?.toUpperCase() ?? ''
  if (rDrive !== tDrive) return null
  const ci = isCaseInsensitive(platform)
  const rCmp = ci ? r.toLowerCase() : r
  const tCmp = ci ? t.toLowerCase() : t
  if (tCmp === rCmp) return ''
  if (tCmp.startsWith(rCmp + '/')) return t.slice(r.length + 1)
  return null
}
