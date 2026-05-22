/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  AcpPathPolicy — guards fs/* peer requests so an agent process cannot reach
 *  outside the session's working directory or into well-known sensitive
 *  locations on disk.
 *
 *  The policy is intentionally text-level (no real fs lstat): the renderer has
 *  no synchronous fs primitives, and we want this to be cheap. Anything beyond
 *  what we can decide from strings is left to the underlying IFileService.
 *
 *  Platform + home directory are injected so this can run in the renderer
 *  (where `process.platform` / `process.env.HOME` are not exposed) and be unit
 *  tested deterministically on every OS.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator, type HostPlatform } from '@universe-editor/platform'

export type AcpPathDecision =
  | { readonly ok: true; readonly normalized: string }
  | { readonly ok: false; readonly reason: string }

export interface IAcpPathPolicy {
  readonly _serviceBrand: undefined
  /**
   * Decide whether `target` is reachable for the session rooted at `cwd`.
   * Both inputs are expected to be absolute filesystem paths in OS-native
   * form (Windows backslashes or POSIX forward slashes are both accepted).
   */
  check(cwd: string, target: string): AcpPathDecision
}

export const IAcpPathPolicy = createDecorator<IAcpPathPolicy>('acpPathPolicy')

const SENSITIVE_SUFFIXES = [
  '/.ssh',
  '/.aws',
  '/.gnupg',
  '/.config/gh',
  '/.docker',
  '/.kube',
  '/.netrc',
  '/.npmrc',
]

const SENSITIVE_FILENAMES = new Set([
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
  'id_rsa',
  'id_ed25519',
  'authorized_keys',
])

function toForwardSlashes(p: string): string {
  return p.replace(/\\/g, '/')
}

function stripTrailingSlash(p: string): string {
  if (p.length <= 1) return p
  return p.endsWith('/') ? p.slice(0, -1) : p
}

function normalizeSegments(p: string): string {
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
  return (escaped ? '__ESCAPED__' : '') + prefix + out.join('/')
}

function basename(p: string): string {
  const idx = p.lastIndexOf('/')
  return idx === -1 ? p : p.slice(idx + 1)
}

export interface AcpPathPolicyEnv {
  readonly platform: HostPlatform
  readonly home: string
}

export class AcpPathPolicy implements IAcpPathPolicy {
  declare readonly _serviceBrand: undefined

  constructor(private readonly _env: AcpPathPolicyEnv) {}

  check(cwd: string, target: string): AcpPathDecision {
    if (!cwd) return { ok: false, reason: 'no workspace root configured' }
    if (!target) return { ok: false, reason: 'empty path' }
    if (target.includes('\0')) return { ok: false, reason: 'path contains NUL byte' }
    const fwd = toForwardSlashes(target)
    if (fwd.startsWith('//')) return { ok: false, reason: 'UNC paths are not allowed' }
    const isAbsolute = fwd.startsWith('/') || /^[a-zA-Z]:\//.test(fwd)
    if (!isAbsolute) return { ok: false, reason: 'path must be absolute' }
    const absNorm = normalizeSegments(fwd)
    if (absNorm.startsWith('__ESCAPED__')) {
      return { ok: false, reason: 'parent-directory segments escape filesystem root' }
    }

    const rel = this._relativeUnder(cwd, absNorm)
    if (rel === null) {
      return { ok: false, reason: `path escapes workspace root (${cwd})` }
    }
    const sensitive = this._sensitivePrefix(absNorm)
    if (sensitive) {
      return { ok: false, reason: `path resolves under sensitive prefix (${sensitive})` }
    }
    if (SENSITIVE_FILENAMES.has(basename(absNorm))) {
      return { ok: false, reason: `filename is denylisted (${basename(absNorm)})` }
    }
    return { ok: true, normalized: absNorm }
  }

  private _relativeUnder(root: string, absNormTarget: string): string | null {
    const r = stripTrailingSlash(normalizeSegments(root))
    if (r.startsWith('__ESCAPED__')) return null
    const t = absNormTarget
    const rDrive = /^([a-zA-Z]):/.exec(r)?.[1]?.toUpperCase() ?? ''
    const tDrive = /^([a-zA-Z]):/.exec(t)?.[1]?.toUpperCase() ?? ''
    if (rDrive !== tDrive) return null
    const ci = this._env.platform === 'win32' || this._env.platform === 'darwin'
    const rNorm = ci ? r.toLowerCase() : r
    const tNorm = ci ? t.toLowerCase() : t
    if (tNorm === rNorm) return ''
    if (tNorm.startsWith(rNorm + '/')) return t.slice(r.length + 1)
    return null
  }

  private _sensitivePrefix(absNormPath: string): string | null {
    const home = this._env.home ? toForwardSlashes(this._env.home) : ''
    if (home) {
      for (const suffix of SENSITIVE_SUFFIXES) {
        const probe = stripTrailingSlash(normalizeSegments(home)) + suffix
        if (absNormPath === probe || absNormPath.startsWith(probe + '/')) return probe
      }
    }
    return null
  }
}
