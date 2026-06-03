/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Mini glob matcher — shared by the search service, the file watcher and the
 *  exclude resolution. Kept intentionally small (no external dependency).
 *
 *  Supports:
 *    - `*`     matches any run of characters except the path separator
 *    - `**`    matches any run of characters including path separators (incl. empty)
 *    - `?`     matches a single character except the path separator
 *    - `{a,b}` brace alternation (non-nested), e.g. `*.{ts,tsx}`
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
    } else if (ch === '{') {
      // Brace alternation `{a,b,c}` -> `(?:a|b|c)`. Non-nested; a literal `{`
      // without a closing `}` is treated as a literal character.
      const close = pattern.indexOf('}', i + 1)
      if (close === -1) {
        body += escapeRegex(ch)
        i += 1
      } else {
        const alts = pattern.slice(i + 1, close).split(',')
        body += '(?:' + alts.map((a) => escapeRegex(a)).join('|') + ')'
        i = close + 1
      }
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

/**
 * Compile a VSCode-style exclude object `{ "<glob>": boolean }` into a matcher.
 * Only keys whose value is exactly `true` participate; `false` entries are
 * dropped (they represent "do not exclude", typically cancelling a lower layer).
 * Returns `null` when nothing is active.
 */
export function makeExcludeMatcher(
  globs: Record<string, unknown>,
): ((relPath: string) => boolean) | null {
  const active = Object.keys(globs).filter((k) => globs[k] === true)
  const patterns = active.flatMap((pattern) => {
    const normalized = pattern.replace(/\\/g, '/').replace(/\/+$/, '')
    if (normalized.endsWith('/**')) {
      return [normalized.slice(0, -3), normalized]
    }
    return [normalized, normalized + '/**']
  })
  return makeGlobMatcher(patterns)
}
