/**
 * Workspace-relative directory paths used by the phone gateway. The PC owns the
 * canonical form and the phone echoes it back; nothing here touches absolute
 * filesystem paths. Zero dependencies on purpose: the PWA and the gateway share
 * this module.
 */

export const MAX_WORKSPACE_RELATIVE_PATH_LENGTH = 4096

export interface ParsedWorkspaceRelativePath {
  /** Canonical `/`-separated form; `''` is the workspace root. */
  readonly path: string
  /** Validated path segments; empty at the workspace root. */
  readonly segments: readonly string[]
}

/**
 * Strictly validates (never normalizes) a workspace-relative path. Rejecting
 * rather than trimming keeps the wire value canonical: backslashes are not
 * separators (POSIX allows them in names), and `URI.joinPath` would silently
 * collapse `..` after the fact, which must not become the security boundary.
 */
export function parseWorkspaceRelativePath(
  value: string | undefined | null,
): ParsedWorkspaceRelativePath | null {
  if (value === undefined || value === null || value === '') {
    return { path: '', segments: [] }
  }
  if (typeof value !== 'string') return null
  if (value.length > MAX_WORKSPACE_RELATIVE_PATH_LENGTH) return null
  if (value.includes('\0') || value.includes('\\')) return null
  if (value.startsWith('/') || /^[A-Za-z]:(?:$|\/)/.test(value)) return null
  const segments = value.split('/')
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return null
  }
  return { path: segments.join('/'), segments }
}

/** Appends one directory name to a canonical parent path. */
export function appendWorkspaceRelativePath(parent: string, name: string): string | null {
  const parentParsed = parseWorkspaceRelativePath(parent)
  const nameParsed = parseWorkspaceRelativePath(name)
  if (parentParsed === null || nameParsed === null) return null
  if (nameParsed.segments.length !== 1) return null
  const path = parentParsed.path === '' ? name : `${parentParsed.path}/${name}`
  return path.length <= MAX_WORKSPACE_RELATIVE_PATH_LENGTH ? path : null
}

/** Parent directory path; `''` for a top-level entry, undefined at the root. */
export function parentWorkspaceRelativePath(path: string): string | undefined {
  const parsed = parseWorkspaceRelativePath(path)
  if (parsed === null || parsed.segments.length === 0) return undefined
  return parsed.segments.slice(0, -1).join('/')
}
