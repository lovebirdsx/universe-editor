/**
 * Pure path helpers backing `workspace.workspaceFolders` / `workspace.name` /
 * `workspace.asRelativePath`. This package is bundled into every extension and
 * cannot reach the platform's path-identity services, so the OS case policy is
 * applied locally (Windows-only case folding, for the containment comparison
 * only — the returned path keeps the caller's casing).
 */

const _isWindows = typeof process === 'object' && process.platform === 'win32'

/** Forward-slash form without trailing slashes (a root `/` is kept). */
function normalizeSlashes(p: string): string {
  let out = p.replace(/\\/g, '/')
  while (out.length > 1 && out.endsWith('/')) out = out.slice(0, -1)
  return out
}

function foldForCompare(p: string): string {
  return _isWindows ? p.toLowerCase() : p
}

/** Basename of a workspace root path, tolerating either separator. */
export function workspaceFolderName(root: string): string {
  const norm = normalizeSlashes(root)
  const idx = norm.lastIndexOf('/')
  return idx === -1 ? norm : norm.slice(idx + 1)
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
