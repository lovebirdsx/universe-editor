/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Mini glob matcher — enough for include/exclude filters in the search service.
 *
 *  Supports:
 *    - `*`  matches any run of characters except path separator
 *    - `**` matches any run of characters including path separators (including empty)
 *    - literal segments
 *  All other regex metacharacters are escaped. Paths are matched against
 *  forward-slash-normalised relative paths (workspace-rooted).
 *--------------------------------------------------------------------------------------------*/

function escapeRegex(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
}

function patternToRegex(pattern: string): RegExp {
  // Tokenise so `**` is treated as one symbol before `*`.
  let body = ''
  let i = 0
  while (i < pattern.length) {
    const ch = pattern[i]!
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` -> match zero or more path segments; `**` alone -> .*
        if (pattern[i + 2] === '/') {
          body += '(?:.*/)?'
          i += 3
        } else {
          body += '.*'
          i += 2
        }
      } else {
        body += '[^/]*'
        i += 1
      }
    } else if (ch === '?') {
      body += '[^/]'
      i += 1
    } else {
      body += escapeRegex(ch)
      i += 1
    }
  }
  return new RegExp('^' + body + '$')
}

/**
 * Compile a list of glob patterns into a single matcher. Returns `null` when
 * the list is empty — callers treat that as "no filter, accept everything".
 * A path matches if ANY pattern matches (OR semantics).
 */
export function makeGlobMatcher(
  patterns: readonly string[],
): ((relPath: string) => boolean) | null {
  if (patterns.length === 0) return null
  const regexes = patterns.map(patternToRegex)
  return (relPath: string) => {
    // Normalise backslashes to forward slashes; strip leading slash.
    const norm = relPath.replace(/\\/g, '/').replace(/^\/+/, '')
    for (const re of regexes) {
      if (re.test(norm)) return true
    }
    return false
  }
}
