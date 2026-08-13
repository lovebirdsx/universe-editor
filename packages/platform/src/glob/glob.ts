/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  The repo's single glob → RegExp engine, with two documented pattern-level
 *  semantics over one shared fragment compiler:
 *
 *    - `compileGlobMatcher`        — extension-surface semantics (ripgrep `-g`
 *                                    style): the pattern is normalized first
 *                                    ({@link normalizeExtensionGlobPattern}) and
 *                                    a slashless pattern matches the basename at
 *                                    ANY depth. Drives `workspace.findFiles` and
 *                                    `createFileSystemWatcher` (via
 *                                    extensions-common, which re-exports these).
 *    - `makeGlobMatcher`           — settings/association semantics: patterns
 *                                    are compiled verbatim, so a pattern
 *                                    without any `/` only matches at the root.
 *                                    Used by editorAssociations, JSON schema
 *                                    fileMatch and (via `makeExcludeMatcher`)
 *                                    files.exclude/search.exclude/watcherExclude.
 *                                    Callers that want basename-at-any-depth add
 *                                    the double-star-slash prefix themselves.
 *
 *  Both matched strings are normalized the same way: backslashes become
 *  forward slashes and leading slashes are stripped. Matching is
 *  case-sensitive on every platform; case-folding for watcher interest keys
 *  happens in the path-comparison layer, not here.
 *--------------------------------------------------------------------------------------------*/

function escapeRegex(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
}

function escapeClassChar(s: string): string {
  return s.replace(/[\\\]]/g, '\\$&')
}

function compileGlobFragment(pattern: string, start: number, end: number, depth: number): string {
  let body = ''
  let i = start
  while (i < end) {
    const ch = pattern[i]!
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
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
      const close = pattern.indexOf('}', i + 1)
      if (close === -1 || close > end || depth >= 3) {
        body += escapeRegex(ch)
        i += 1
      } else {
        const alts = pattern
          .slice(i + 1, close)
          .split(',')
          .map((alt) => compileGlobFragment(alt, 0, alt.length, depth + 1))
        body += '(?:' + alts.join('|') + ')'
        i = close + 1
      }
    } else if (ch === '[') {
      const close = pattern.indexOf(']', i + 1)
      if (close === -1 || close > end) {
        body += escapeRegex(ch)
        i += 1
      } else {
        let inner = pattern.slice(i + 1, close)
        let negate = ''
        if (inner.startsWith('!') || inner.startsWith('^')) {
          negate = '^'
          inner = inner.slice(1)
        }
        body += '[' + negate + inner.split('').map(escapeClassChar).join('') + ']'
        i = close + 1
      }
    } else {
      body += escapeRegex(ch)
      i += 1
    }
  }
  return body
}

/** Normalize the matched string the same way both entries do. */
function normalizeMatchedPath(relPath: string): string {
  return relPath.replace(/\\/g, '/').replace(/^\/+/, '')
}

/**
 * Pattern normalization of the extension-surface glob pipeline: backslashes
 * become forward slashes, leading/trailing slashes are stripped, and a
 * slashless pattern gains a slash-suffixed double-star prefix so it keeps its
 * ripgrep `-g`-style "basename at any depth" meaning once it gets anchored
 * beneath an enumeration root (the renderer's findFiles engine shim relies on
 * this too). A bare `**` and the empty pattern pass through untouched.
 */
export function normalizeExtensionGlobPattern(pattern: string): string {
  let normalized = pattern.replace(/\\/g, '/').replace(/^\/+/, '')
  while (normalized.endsWith('/')) normalized = normalized.slice(0, -1)
  if (normalized === '' || normalized === '**' || normalized.includes('/')) return normalized
  return `**/${normalized}`
}

/**
 * Compile `pattern` into a matcher over forward-slash relative paths, using
 * the extension-surface normalization: a slashless pattern matches the
 * basename at any depth. Supports `*`, `**`, `?`, `{a,b}` (alternatives
 * compile as glob fragments) and `[...]` character classes (`!`/`^` negation,
 * `a-z` ranges); everything else matches literally, including `{`/`[` without
 * a closer.
 */
export function compileGlobMatcher(pattern: string): (relPath: string) => boolean {
  const normalized = normalizeExtensionGlobPattern(pattern)
  const regex = new RegExp('^' + compileGlobFragment(normalized, 0, normalized.length, 0) + '$')
  return (relPath: string) => regex.test(normalizeMatchedPath(relPath))
}

/**
 * Compile a list of glob patterns into a single matcher, using the settings /
 * association semantics: patterns are compiled verbatim (in particular no
 * slashless→basename expansion — that difference vs {@link compileGlobMatcher}
 * is deliberate, see the module header). Returns `null` when the list is
 * empty — callers treat that as "no filter, accept everything". A path
 * matches if ANY pattern matches (OR semantics).
 */
export function makeGlobMatcher(
  patterns: readonly string[],
): ((relPath: string) => boolean) | null {
  if (patterns.length === 0) return null
  const regexes = patterns.map(
    (pattern) => new RegExp('^' + compileGlobFragment(pattern, 0, pattern.length, 0) + '$'),
  )
  return (relPath: string) => {
    const norm = normalizeMatchedPath(relPath)
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
