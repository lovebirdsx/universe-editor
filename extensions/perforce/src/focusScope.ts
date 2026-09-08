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
import { collapseScopeDirs, isUnderAny } from './pathUtil.js'

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

/** Whether a path is absolute after slash normalization: a Windows drive
 *  (`C:/…`), a UNC root (`//server/share/…`) or a POSIX root (`/…` on non-Windows).
 *  On Windows, a single leading slash (`/foo`) is considered a root-relative path
 *  and handled as relative onto workspaceRoot. */
function isAbsolutePath(value: string): boolean {
  const s = value.replace(/\\/g, '/')
  if (/^[a-zA-Z]:\//.test(s) || s.startsWith('//')) return true
  if (process.platform !== 'win32' && s.startsWith('/')) return true
  return false
}

/**
 * Canonical absolute path: forward slashes, no `.`/`..` segments, no trailing
 * separator. Recognizes Windows drive (`C:/…`), UNC (`//server/share/…`) and
 * POSIX (`/…`) roots. Returns undefined when the input escapes its own root via
 * `..` or is degenerate (`C:/`, `/`, `//`).
 */
function canonicalAbsolute(value: string): string | undefined {
  const s = value.replace(/\\/g, '/')
  const drive = /^([a-zA-Z]):\/(.*)$/.exec(s)
  if (drive) {
    const rest = canonicalRelative(drive[2]!)
    return rest === undefined ? undefined : `${drive[1]}:/${rest}`
  }
  if (s.startsWith('//')) {
    const parts = s.split('/')
    const server = parts[2]
    const share = parts[3]
    if (server === undefined || share === undefined || server === '' || share === '') {
      return undefined
    }
    const tail = parts.slice(4).join('/')
    if (tail === '') return `//${server}/${share}`
    const rest = canonicalRelative(tail)
    return rest === undefined ? undefined : `//${server}/${share}/${rest}`
  }
  if (s.startsWith('/')) {
    const rest = canonicalRelative(s.slice(1))
    return rest === undefined ? undefined : `/${rest}`
  }
  return undefined
}

/**
 * Dedupe and collapse a list of canonical directory paths to their shallowest
 * entries. Delegated to {@link collapseScopeDirs}.
 */
function collapseDirs(dirs: readonly string[]): string[] {
  return collapseScopeDirs(dirs)
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
  const root = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '')
  return collapseDirs(rels).map((rel) => `${root}/${rel}`)
}

/** Stat shape the split resolver needs — injected so the function stays pure
 *  and unit-testable without touching the disk. Mirrors the subset of the
 *  host `workspace.fs.stat` result the split actually reads. */
export interface FocusEntryStat {
  readonly isDirectory: boolean
}

/**
 * Resolve the focus configuration into absolute local DIRECTORIES and FILES
 * separately. `resolveFocusScopeDirs` treats every entry as a directory, which
 * misroutes a file entry (`Source/Client/Run.bat`) into a recursive `<file>/...`
 * reconcile filespec that p4 answers as no-such-file (exit 0, empty) — and the
 * empty answer is checkpointed as "clean" forever, so the file's real drift is
 * never re-examined. The caller stats each entry on disk: a directory entry
 * joins the recursive scan scope, a file entry joins a per-file narrow query
 * scope that is re-verified fresh every session and never checkpointed.
 *
 * `dirs` collapse to their shallowest ancestors (`A` + `A/B` → `A`), and a file
 * entry that already sits under a resolved directory is dropped (the recursive
 * scan covers it). A MISSING entry (`stat` returns undefined) is kept in
 * `files` — the per-file query tolerates a vanished path the way the watcher
 * tolerates deletes, whereas guessing "it was a directory" would resurrect the
 * bad filespec this split exists to kill. Returns empty buckets when focus is
 * disabled or empty.
 */
export async function resolveFocusScope(
  config: FocusScopeConfig,
  workspaceRoot: string,
  stat: (absolutePath: string) => Promise<FocusEntryStat | undefined>,
): Promise<{ dirs: string[]; files: string[] }> {
  if (!config.enabled) return { dirs: [], files: [] }
  const root = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '')
  const rels: string[] = []
  for (const key of Object.keys(config.folders)) {
    if (config.folders[key] !== true) continue
    const rel = canonicalRelative(key)
    if (rel === undefined) continue
    rels.push(rel)
  }
  const abs = rels.map((rel) => `${root}/${rel}`)
  const stats = await Promise.all(abs.map((p) => stat(p)))
  const dirCandidates: string[] = []
  const fileCandidates: string[] = []
  for (let i = 0; i < abs.length; i++) {
    const p = abs[i]!
    const s = stats[i]
    if (s !== undefined && s.isDirectory) dirCandidates.push(p)
    else fileCandidates.push(p)
  }
  const dirs = collapseDirs(dirCandidates)
  const files = fileCandidates.filter((p) => !isUnderAny(p, dirs))
  return { dirs, files }
}

/**
 * Resolve the `perforce.reconcile.excludeFolders` setting into absolute local
 * directories to skip during reconcile. Relative entries are joined onto the
 * workspace root; absolute entries (drive / UNC / POSIX) are preserved as-is.
 * Empty or escaping entries are dropped, and nested entries collapse to their
 * shallowest ancestor.
 */
export function resolveExcludeDirs(values: readonly string[], workspaceRoot: string): string[] {
  const root = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '')
  const dirs: string[] = []
  for (const value of values) {
    if (isAbsolutePath(value)) {
      const abs = canonicalAbsolute(value)
      if (abs !== undefined) dirs.push(abs)
    } else {
      const rel = canonicalRelative(value)
      if (rel !== undefined) dirs.push(`${root}/${rel}`)
    }
  }
  return collapseDirs(dirs)
}
