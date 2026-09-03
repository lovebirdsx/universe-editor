/**
 * p4 filespec escaping. `@ # * %` are filespec metacharacters (revision range,
 * wildcard, and the percent-escape introducer) — a literal occurrence in a path
 * would be re-interpreted by the server and silently change the scope's meaning,
 * so they must be percent-encoded. `%` is escaped first so the `%` the other
 * escapes introduce is not itself re-escaped.
 */

import { scopeKey } from './pathUtil.js'

export function escapeFilespecPath(path: string): string {
  return path.replace(/%/g, '%25').replace(/@/g, '%40').replace(/#/g, '%23').replace(/\*/g, '%2A')
}

/** Build a p4 filespec scoped to `path`: a recursive `<dir>/...` for a directory,
 *  or the escaped path itself for a file. Trailing `/`/`\` are dropped before the
 *  `/...` so `dir/` and `dir\\` scope the same directory. */
export function buildScopeFilespec(path: string, isDirectory: boolean): string {
  if (!isDirectory) return escapeFilespecPath(path)
  const trimmed = path.replace(/[/\\]+$/, '')
  return `${escapeFilespecPath(trimmed)}/...`
}

/** One user-selected target of a get-revision: a host path plus directory-ness. */
export interface SyncScopeTarget {
  readonly path: string
  readonly isDirectory: boolean
}

/** Strict containment on scope keys: `path` sits *under* `dir` (not equal to
 *  it), directory-boundary aware so `A` never matches `AB`. */
function isStrictlyUnder(path: string, dir: string): boolean {
  const key = scopeKey(path)
  const d = scopeKey(dir)
  return key.length > d.length && key.startsWith(`${d}/`)
}

/**
 * Normalize a get-revision selection into the filespec list to hand a sync.
 *
 *  Each target becomes {@link buildScopeFilespec} (metachar escaping, directory
 *  `<dir>/...`); duplicates collapse (drive-letter case folded, full-path case
 *  per host policy); anything nested under a selected directory is dropped —
 *  the directory's `/...` already covers it, and p4 would list the overlap
 *  twice. Input order is preserved so progress and summaries stay stable.
 *
 *  Revision suffixes (`@CL` / `#rev`) are deliberately NOT appended here: the
 *  client's `_syncTargets` joins them after escaping, so an escaped path can
 *  never smuggle a sigil into the suffix position.
 */
export function buildSyncFilespecs(targets: readonly SyncScopeTarget[]): string[] {
  const dirs = targets.filter((t) => t.isDirectory).map((t) => t.path)
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of targets) {
    if (!t.path) continue
    if (dirs.some((d) => d !== t.path && isStrictlyUnder(t.path, d))) continue
    const key = scopeKey(t.path)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(buildScopeFilespec(t.path, t.isDirectory))
  }
  return out
}
