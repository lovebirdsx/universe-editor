/**
 * Extension-side resolution of the workspace "focus folders" setting into
 * absolute local directories for the reconcile scan. The renderer has its own
 * normalizer (focusScopeUtils) that extensions can't import, so this is a
 * minimal pure copy of the relevant rules.
 *
 * The semantics mirror `files.exclude`: only keys whose value is exactly `true`
 * participate, so a higher configuration layer can cancel a lower one's entry
 * with `false`. Entries that address the workspace root itself or escape it via
 * `..` are dropped rather than clamped — clamping would turn a typo into "focus
 * everything".
 */
import { isUnderAny, scopeKey } from './pathUtil.js'

/** The subset of `workspace.focusEnabled` / `workspace.focusFolders` the
 *  reconcile scope cares about. */
export interface FocusScopeConfig {
  readonly enabled: boolean
  readonly folders: Readonly<Record<string, unknown>>
}

/**
 * Canonical workspace-relative path: forward slashes, no `.`/`..` segments, no
 * leading or trailing separator. Returns undefined when the input addresses the
 * workspace root itself (`.`, `/`, ``) or escapes it via `..`.
 */
function canonicalRelative(value: string): string | undefined {
  const segments = value
    .replace(/\\/g, '/')
    .split('/')
    .filter((s) => s.length > 0 && s !== '.')

  const out: string[] = []
  for (const segment of segments) {
    if (segment === '..') {
      if (out.length === 0) return undefined
      out.pop()
      continue
    }
    out.push(segment)
  }
  return out.length === 0 ? undefined : out.join('/')
}

/**
 * Resolve the focus configuration into absolute local directories, or `[]` when
 * focus is disabled or empty — the caller then falls back to the opened
 * workspace folder. Nested entries collapse to their shallowest ancestor
 * (focusing both `A` and `A/B` yields just `A`), since overlapping reconcile
 * scopes would scan the same files twice.
 */
export function resolveFocusScopeDirs(config: FocusScopeConfig, workspaceRoot: string): string[] {
  if (!config.enabled) return []
  const rels: string[] = []
  for (const key of Object.keys(config.folders)) {
    if (config.folders[key] !== true) continue
    const rel = canonicalRelative(key)
    if (rel === undefined) continue
    rels.push(rel)
  }
  // Dedupe on the same key the containment test uses. Keying by raw string here
  // would let `Client` and `client` both survive on Windows, and then the
  // case-insensitive collapse below would find each nested under the other and
  // drop BOTH — silently widening the scan back to the whole opened folder.
  const seen = new Set<string>()
  const unique: string[] = []
  for (const rel of rels) {
    const key = scopeKey(rel)
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(rel)
  }
  const collapsed = unique.filter(
    (rel) => !unique.some((other) => other !== rel && isUnderAny(rel, [other])),
  )
  const root = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '')
  return collapsed.map((rel) => `${root}/${rel}`)
}
