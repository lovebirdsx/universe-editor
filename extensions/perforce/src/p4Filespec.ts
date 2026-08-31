/**
 * p4 filespec escaping. `@ # * %` are filespec metacharacters (revision range,
 * wildcard, and the percent-escape introducer) — a literal occurrence in a path
 * would be re-interpreted by the server and silently change the scope's meaning,
 * so they must be percent-encoded. `%` is escaped first so the `%` the other
 * escapes introduce is not itself re-escaped.
 */

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
