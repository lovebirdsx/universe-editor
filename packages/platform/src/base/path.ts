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

function isCaseInsensitive(platform: HostPlatform): boolean {
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
