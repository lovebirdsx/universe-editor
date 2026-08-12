/**
 * Shared glob → RegExp compiler for the extension surface (`workspace.findFiles`
 * in the renderer, `workspace.createFileSystemWatcher` in the ext host). Kept
 * dependency-free so both processes can import it.
 *
 * Semantics (matched against a workspace-relative, forward-slash path):
 *   - `*`      matches any run of characters except the path separator
 *   - `**`     matches any run of characters including separators; in the
 *              slash-suffixed form it also matches zero segments, so a leading
 *              double-star matches files at the root too
 *   - `?`      matches a single character except the path separator
 *   - `{a,b}`  brace alternation; alternatives compile as glob fragments
 *              (non-nested in practice)
 *   - `[...]`  character class, with `!`/`^` negation and `a-z` ranges
 *   - a pattern without any `/` matches the basename at ANY depth (ripgrep
 *     `-g` style), i.e. `*.ts` behaves like the double-star-prefixed form
 * Matching is case-sensitive on every platform. All other regex metacharacters
 * are escaped.
 */

function escapeRegex(s: string): string {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
}

function escapeClassChar(s: string): string {
  return s.replace(/[\\\]]/g, '\\$&')
}

function compileFragment(pattern: string, start: number, end: number, depth: number): string {
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
          .map((alt) => compileFragment(alt, 0, alt.length, depth + 1))
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

/**
 * Compile `pattern` into a matcher over workspace-relative paths. The matched
 * value is normalized first: backslashes become forward slashes and leading
 * slashes are stripped, so Windows-style inputs work unchanged.
 */
export function compileGlobMatcher(pattern: string): (relPath: string) => boolean {
  let normalized = pattern.replace(/\\/g, '/').replace(/^\/+/, '')
  while (normalized.endsWith('/')) normalized = normalized.slice(0, -1)
  // A slashless pattern matches the basename at any depth (ripgrep `-g` style).
  if (!normalized.includes('/')) normalized = '**/' + normalized
  const regex = new RegExp('^' + compileFragment(normalized, 0, normalized.length, 0) + '$')
  return (relPath: string) => regex.test(relPath.replace(/\\/g, '/').replace(/^\/+/, ''))
}
