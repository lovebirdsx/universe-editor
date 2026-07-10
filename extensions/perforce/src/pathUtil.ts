/** Normalize a filesystem path for comparison / map keys: forward slashes, no
 *  trailing slash, lower-cased Windows drive letter. Shared by the client
 *  manager (routing) and discovery (dedupe) so both key on the same form.
 *  Mirrors extensions/git/src/pathUtil.ts. */
export function norm(p: string): string {
  let s = p.replace(/\\/g, '/').replace(/\/+$/, '')
  if (/^[a-zA-Z]:/.test(s)) s = s[0]!.toLowerCase() + s.slice(1)
  return s
}

/** Convert a host-shaped file URI (scheme `file`, path like `/D:/a/b.txt` on
 *  Windows or `/a/b` on posix) to an OS filesystem path. Returns undefined for
 *  non-file URIs (e.g. an untitled or virtual document). Pure, so unit-testable
 *  without spawning p4. */
export function uriToFsPath(uri: { scheme?: string; path?: string }): string | undefined {
  if (uri.scheme !== 'file' || !uri.path) return undefined
  let p = decodeURIComponent(uri.path)
  // `/D:/foo` → `D:/foo` (strip the leading slash before a drive letter).
  if (/^\/[a-zA-Z]:/.test(p)) p = p.slice(1)
  return p
}
