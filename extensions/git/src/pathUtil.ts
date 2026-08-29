/** Normalize a filesystem path for comparison / map keys: forward slashes, no
 *  trailing slash, lower-cased Windows drive letter. Shared by the repository
 *  manager (routing) and repo discovery (dedupe) so both key on the same form. */
export function norm(p: string): string {
  let s = p.replace(/\\/g, '/').replace(/\/+$/, '')
  if (/^[a-zA-Z]:/.test(s)) s = s[0]!.toLowerCase() + s.slice(1)
  return s
}

/**
 * Compare two normalized paths the way the platform's filesystem does. Windows is
 * case-insensitive, so paths reaching us from different sources — a repo root from
 * `rev-parse --show-toplevel` vs. a worktree path recorded by `worktree add` — can
 * differ in case while naming the same directory.
 */
const fold = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p)

/** True when both paths name the same directory. Inputs need not be normalized. */
export const samePath = (a: string, b: string): boolean => fold(norm(a)) === fold(norm(b))

/** True when `child` lies strictly inside `parent`. Inputs need not be normalized. */
export const isSubPath = (parent: string, child: string): boolean =>
  fold(norm(child)).startsWith(`${fold(norm(parent))}/`)
