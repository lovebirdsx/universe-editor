/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Normalization for the Perforce Graph's path scope (one or many paths).
 *
 *  A merged-history tab's identity is its scope, so the scope must be canonical:
 *  the same selection clicked in a different order has to produce the same tab id,
 *  otherwise every click order opens a new tab and churns the view-state LRU.
 *--------------------------------------------------------------------------------------------*/

export interface GraphScopePath {
  /** Bare path on the SCM host (already resolved by `scmHostPath`, not a URI). */
  path: string
  isDirectory: boolean
}

/**
 * Identity key for a scope path. Mirrors the extension's `pathUtil.norm`: forward
 * slashes, no trailing slash, lowercased drive letter — and **nothing else**.
 *
 * Deliberately NOT `scmProviderPathKey`, which lowercases the whole path: on a
 * case-sensitive host that folds two genuinely different files into one tab.
 */
export function scopePathKey(path: string): string {
  let p = path.replace(/\\/g, '/')
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1)
  if (/^[a-zA-Z]:/.test(p)) p = p[0]!.toLowerCase() + p.slice(1)
  return p
}

/** Trailing path segment, for the tab label. Works on either separator. */
function lastSegment(path: string): string {
  const p = path.replace(/\\/g, '/').replace(/\/+$/, '')
  const i = p.lastIndexOf('/')
  return i === -1 ? p : p.slice(i + 1)
}

/**
 * Canonicalize a selection into the scope a `PerforceGraphEditorInput` is keyed
 * by: duplicates dropped (first wins), the rest sorted by identity key, and a
 * label of `<first basename>` plus ` +N` for the remaining paths.
 *
 * Only *identical* paths are dropped. A file nested under a selected directory is
 * kept — collapsing it is `buildSyncFilespecs`' job on the extension side, and the
 * display (label `+N`, tooltip) deliberately reflects what the user picked rather
 * than the collapsed query. Don't "unify" the two granularities.
 */
export function normalizeGraphScopeSelection(paths: readonly GraphScopePath[]): {
  paths: GraphScopePath[]
  label: string
} {
  const seen = new Set<string>()
  const unique: GraphScopePath[] = []
  for (const p of paths) {
    const key = scopePathKey(p.path)
    if (key === '' || seen.has(key)) continue
    seen.add(key)
    unique.push({ path: p.path, isDirectory: p.isDirectory })
  }
  unique.sort((a, b) => (scopePathKey(a.path) < scopePathKey(b.path) ? -1 : 1))
  const first = unique[0]
  const label =
    first === undefined
      ? ''
      : unique.length > 1
        ? `${lastSegment(first.path)} +${unique.length - 1}`
        : lastSegment(first.path)
  return { paths: unique, label }
}
