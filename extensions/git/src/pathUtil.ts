/** Normalize a filesystem path for comparison / map keys: forward slashes, no
 *  trailing slash, lower-cased Windows drive letter. Shared by the repository
 *  manager (routing) and repo discovery (dedupe) so both key on the same form. */
export function norm(p: string): string {
  let s = p.replace(/\\/g, '/').replace(/\/+$/, '')
  if (/^[a-zA-Z]:/.test(s)) s = s[0]!.toLowerCase() + s.slice(1)
  return s
}
