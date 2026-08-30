/** Normalize a filesystem path for comparison / map keys: forward slashes, no
 *  trailing slash, lower-cased Windows drive letter. Shared by the client
 *  manager (routing) and discovery (dedupe) so both key on the same form.
 *  Mirrors extensions/git/src/pathUtil.ts. */
export function norm(p: string): string {
  let s = p.replace(/\\/g, '/').replace(/\/+$/, '')
  if (/^[a-zA-Z]:/.test(s)) s = s[0]!.toLowerCase() + s.slice(1)
  return s
}

/** Whether the host filesystem is case-insensitive. */
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin'

/**
 * Comparison key for a *scope* path: {@link norm} plus the host case policy.
 *
 * Scope comparison has one side the user typed (a focus folder, `Client`) and one
 * side p4 or the OS reported (`client`), so on Windows/macOS their case will not
 * match even though they name the same directory. `norm` alone folds only the
 * drive letter and is right where both sides come from the same OS-reported
 * source (client routing, dedupe map keys) — folding more there would merge two
 * genuinely distinct paths on linux.
 */
export function scopeKey(p: string): string {
  const s = norm(p)
  return CASE_INSENSITIVE_FS ? s.toLowerCase() : s
}

/**
 * Whether `path` equals or sits under one of `dirs`, using {@link scopeKey} for
 * identity. The containment check is directory-boundary aware (`path` must equal
 * `dir` or start with `dir + '/'`), so `A` never matches `AB`. Empty `dirs`
 * matches nothing. Pure, so unit-testable without spawning p4.
 */
export function isUnderAny(path: string, dirs: readonly string[]): boolean {
  if (dirs.length === 0) return false
  const key = scopeKey(path)
  for (const dir of dirs) {
    const d = scopeKey(dir)
    if (key === d) return true
    if (key.length > d.length && key.startsWith(`${d}/`)) return true
  }
  return false
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

/**
 * Convert a Perforce **client-syntax** path to a local filesystem path.
 *
 * The `clientFile` field of `p4 opened` and `p4 reconcile -n` is in *client
 * syntax* — `//<clientName>/relative/path` — NOT a local OS path (only `p4 fstat`
 * reports `clientFile` as a local path). Feeding that `//…` form to `readFile`
 * (Windows treats it as a UNC host) or to a `file:` URI (the `//` becomes a bogus
 * authority) breaks diffs and file-open. Client syntax is always rooted at the
 * client root by definition, so the conversion is a pure prefix swap: drop
 * `//<clientName>/` and join the remainder onto `clientRoot`. No `p4 where`
 * round-trip is needed.
 *
 * Values that are already local paths (drive-letter or posix-absolute, i.e. not
 * starting with `//`) are returned unchanged, so this is safe to apply
 * unconditionally to any `clientFile`. Output uses forward slashes.
 */
export function clientToLocalPath(clientFile: string, clientRoot: string): string {
  if (!clientFile.startsWith('//')) return clientFile
  const rest = clientFile.slice(2)
  const slash = rest.indexOf('/')
  if (slash === -1) return clientFile // degenerate: `//clientName` with no path
  const relative = rest.slice(slash + 1)
  const root = clientRoot.replace(/\\/g, '/').replace(/\/+$/, '')
  return `${root}/${relative}`
}
