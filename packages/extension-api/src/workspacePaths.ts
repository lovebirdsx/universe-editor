/**
 * Pure path helpers backing `workspace.workspaceFolders` / `workspace.name` /
 * `workspace.asRelativePath`. This package is bundled into every extension and
 * cannot reach the platform's path-identity services, so the OS case policy is
 * applied locally (Windows-only case folding, for the containment comparison
 * only — the returned path keeps the caller's casing).
 *
 * The slash normalization itself lives in `@universe-editor/primitives`,
 * shared with the kernel's path helpers — only the policy on top (case folding,
 * the "outside the root → return the input untouched" contract) stays here.
 */

import { basename, normalizeSlashes } from '@universe-editor/primitives'

const _isWindows = typeof process === 'object' && process.platform === 'win32'

function foldForCompare(p: string): string {
  return _isWindows ? p.toLowerCase() : p
}

/** Basename of a workspace root path, tolerating either separator. */
export function workspaceFolderName(root: string): string {
  return basename(normalizeSlashes(root))
}

/**
 * `workspace.asRelativePath` against the workspace `root`: a path inside the
 * root comes back root-relative (forward slashes, caller's casing);
 * `includeFolder` prepends the folder name. Anything outside the root is
 * returned untouched.
 */
export function asRelativePathImpl(root: string, input: string, includeFolder: boolean): string {
  const r = normalizeSlashes(root)
  const t = normalizeSlashes(input)
  const rCmp = foldForCompare(r)
  const tCmp = foldForCompare(t)
  let rel: string | undefined
  if (tCmp === rCmp) rel = ''
  else if (rCmp !== '' && tCmp.startsWith(rCmp + '/')) rel = t.slice(r.length + 1)
  if (rel === undefined) return input
  if (includeFolder) {
    const name = workspaceFolderName(r)
    return rel === '' ? name : `${name}/${rel}`
  }
  return rel === '' ? '.' : rel
}
