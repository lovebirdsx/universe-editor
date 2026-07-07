/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  File-path detection for rendered markdown — recognizes bare filesystem paths
 *  in plain text (e.g. `src/foo/bar.ts:10:5`) so they can become clickable links.
 *
 *  The grammar mirrors the terminal's link provider: Windows/Unix absolute paths,
 *  relative paths that carry at least one directory separator, and an optional
 *  `:line:col` / `(line,col)` location suffix. The directory-separator rule is
 *  deliberate — it keeps bare words like `package.json` or `index.ts` from being
 *  mistaken for links. Explicit markdown links (`[x](index.ts)`) bypass this and
 *  are always treated as paths, since they signal intent.
 *--------------------------------------------------------------------------------------------*/

// Known file extensions, alphabetical. Order is irrelevant because EXT_TAIL
// anchors the end of the extension (see below) — the regex backtracks to the
// longest valid extension regardless of listing order.
const EXTS = [
  'astro',
  'bash',
  'c',
  'cc',
  'cfg',
  'cjs',
  'conf',
  'cpp',
  'cs',
  'css',
  'csv',
  'cts',
  'dart',
  'elm',
  'env',
  'ex',
  'exs',
  'fish',
  'go',
  'gradle',
  'graphql',
  'h',
  'hpp',
  'hs',
  'htm',
  'html',
  'ini',
  'java',
  'js',
  'json',
  'json5',
  'jsonc',
  'jsonl',
  'jsx',
  'kt',
  'kts',
  'less',
  'lua',
  'md',
  'mdx',
  'mjs',
  'mts',
  'php',
  'pl',
  'properties',
  'proto',
  'ps1',
  'py',
  'pyi',
  'r',
  'rb',
  'rs',
  'sass',
  'scala',
  'scss',
  'sh',
  'sql',
  'styl',
  'svelte',
  'swift',
  'tf',
  'toml',
  'ts',
  'tsx',
  'txt',
  'vue',
  'xml',
  'yaml',
  'yml',
  'zig',
  'zsh',
].join('|')

// The extension must be followed by a non-extension character (or end / a
// location suffix). Without this, `.jsonl` matches `js` and leaves `onl`, and
// `.css` matches `cs` leaving `s`. The negative lookahead forces the regex to
// extend to the longest valid extension.
const EXT_TAIL = '(?![A-Za-z0-9])'
const EXT = `\\.(?:${EXTS})${EXT_TAIL}`

// Characters never allowed inside a path segment: whitespace & control chars,
// quotes, angle brackets, shell/glob metacharacters, markdown / clause
// punctuation (backtick, parens, brackets, comma, semicolon, braces) and EVERY
// non-ASCII char. Excluding these stops a bare path from crossing an inline-code
// boundary or swallowing the surrounding prose. Non-ASCII is added back in a
// controlled way below (NAL) — this base class stays ASCII-only so the two
// building blocks are disjoint (no overlapping alternation → no backtracking).
const NON_SEG = '\\s\\x00-\\x1f"\'`<>|*?,;{}()\\[\\]\\u0080-\\uffff'
// Segment for absolute paths. Excludes the path separators '/' and '\' (a
// segment can't span a directory boundary) while still allowing ':' — a raw
// colon may appear inside a segment; the Windows drive prefix and the :line
// suffix are matched separately. Excluding the separators is CRITICAL: when SEG
// could itself contain '/', the `(?:SEG+/)*SEG+` alternations in WIN_ABS/UNIX_ABS
// degenerated into a classic `(a+)+` shape and backtracked catastrophically
// (exponentially) on slash-dense non-path text — e.g. an 8KB base64 `data:` URL
// pasted into a message froze the renderer for tens of seconds.
const SEG = `[^${NON_SEG}/\\\\]`
// Segment for the relative grammar: additionally bars ':' so a segment can't eat
// the location suffix. (Separators are already excluded by SEG above.)
const REL_SEG = `[^${NON_SEG}:/\\\\]`

// A Non-ASCII Letter/number (CJK ideographs, kana, etc.) — but NOT full-width
// punctuation (`（）·——…`, which are \p{P}/\p{S}), so those stay path boundaries.
// The negative lookahead makes this class DISJOINT from SEG/REL_SEG (which are
// ASCII-only): `(?:SEG|NAL)` is therefore an unambiguous either/or with no shared
// character, so `(?:SEG|NAL)+` can't backtrack across the alternation. Requires
// the `u` flag on every regex that embeds it (all the *_U regexes below).
const NAL = `(?:(?![\\x00-\\x7f])[\\p{L}\\p{N}])`
// CJK-aware segments: an ASCII path char OR a non-ASCII letter/number. Used for
// grammars that should recognize Chinese file/dir names (`个人考核/2026q1.md`).
const CJK_SEG = `(?:${SEG}|${NAL})`
const CJK_REL_SEG = `(?:${REL_SEG}|${NAL})`

// Windows absolute:   C:\path\file.ts  or  C:/path/file.ts
const WIN_ABS = `[A-Za-z]:[/\\\\](?:${CJK_SEG}+[/\\\\])*${CJK_SEG}+${EXT}`
// Unix absolute or relative dot-slash:  /path/file.ts  ./path/file.ts  ../path/file.ts
const UNIX_ABS = `\\.{0,2}/(?:${CJK_SEG}+/)*${CJK_SEG}+${EXT}`
// Relative with at least one dir component:  src/foo/bar.ts  个人考核/2026q1.md
const REL = `(?:${CJK_REL_SEG}+[/\\\\])+${CJK_REL_SEG}+${EXT}`
// Extension-less variants. `@` mentions are explicit file references so they may
// omit a known extension; bare relative dirs (REL_NO_EXT) are also accepted, but
// ONLY when they contain a non-ASCII segment (enforced in matchFilePathAt by the
// hasNonAscii check) so plain `and/or` / `2024/01/02` prose stays untouched.
const WIN_ABS_NO_EXT = `[A-Za-z]:[/\\\\](?:${CJK_SEG}+[/\\\\])*${CJK_SEG}+`
const UNIX_ABS_NO_EXT = `\\.{0,2}/(?:${CJK_SEG}+/)*${CJK_SEG}+`
const REL_NO_EXT = `(?:${CJK_REL_SEG}+[/\\\\])+${CJK_REL_SEG}+`
// Bare relative dir for the non-`@` matcher: a CJK path with NO known extension
// is only a link when it has at least TWO separators (three-plus segments), so
// single-slash Chinese phrases (`我的读/写`, `输入/输出`, `个人考核/2026q2`)
// stay plain prose. `@` mentions and extension-anchored paths keep 1 separator.
const REL_NO_EXT_DEEP = `(?:${CJK_REL_SEG}+[/\\\\]){2,}${CJK_REL_SEG}+`

// Optional :line:col  or  (line,col)
const LOC = `(?::(\\d+)(?::(\\d+))?|\\((\\d+)(?:,(\\d+))?\\))?`

/**
 * The path-with-optional-location pattern, for reuse (e.g. the terminal link
 * provider). Only the extension-anchored grammar — bare extension-less dirs are
 * NOT included here, since a terminal dump can't disambiguate `读/写` from prose.
 */
export const FILE_PATH_PATTERN = `(${WIN_ABS}|${UNIX_ABS}|${REL})${LOC}`

// Anchored at the start of a slice so callers can probe position-by-position.
// Both flavors carry NAL, so both need the `u` flag. The non-`@` matcher adds a
// bare extension-less directory branch (last alternative) gated by hasNonAscii.
const FILE_PATH_AT_RE = new RegExp(`^(${WIN_ABS}|${UNIX_ABS}|${REL}|${REL_NO_EXT_DEEP})${LOC}`, 'u')
const AT_FILE_PATH_AT_RE = new RegExp(
  `^@(${WIN_ABS_NO_EXT}|${UNIX_ABS_NO_EXT}|${REL_NO_EXT})${LOC}`,
  'u',
)
// A path is "extension-less" (fell through to the bare-dir branch) unless it
// matches one of the extension-anchored grammars. Used to gate such matches on
// containing a non-ASCII segment.
const HAS_KNOWN_EXT_RE = new RegExp(`^(?:${WIN_ABS}|${UNIX_ABS}|${REL})${LOC}$`, 'u')
// Preceding-char guard: a CJK letter/number just before the match means we're
// mid-word (`我的读/写` must not start a path at `读`). ASCII word chars are
// handled by a separate cheap test.
const PREV_CJK_RE = new RegExp(`^${NAL}$`, 'u')
const HAS_NON_ASCII_RE = /[^\x00-\x7f]/

export interface FilePathMatch {
  /** Full matched text including any location suffix. */
  readonly full: string
  /** The path portion (no location suffix). */
  readonly path: string
  readonly line: number | undefined
  readonly col: number | undefined
}

export interface FilePathTarget {
  readonly path: string
  readonly line?: number
  readonly col?: number
  readonly fragment?: string
}

export function stripFilePathLinkPrefix(href: string): string {
  return href.startsWith('@') && href.length > 1 ? href.slice(1) : href
}

/** True for a Windows drive-absolute path like `C:\foo` or `D:/foo` (one letter + `:` + separator). */
export function isWindowsDrivePath(p: string): boolean {
  return /^[A-Za-z]:[/\\]/.test(p)
}

/**
 * Try to match a file path anchored at index {@link i} of {@link text}. Returns
 * `null` when no path starts there. Mirrors the inline parser's left-to-right
 * scan so it runs once per character at most.
 */
export function matchFilePathAt(text: string, i: number): FilePathMatch | null {
  // Avoid matching mid-token: a preceding ASCII word char (`xsrc/a.ts`) or a
  // preceding CJK letter/number (so `我的读/写` doesn't start a path at `读`).
  if (i > 0 && /[A-Za-z0-9_]/.test(text[i - 1] ?? '')) return null
  if (i > 0 && PREV_CJK_RE.test(text[i - 1] ?? '')) return null
  const slice = text.slice(i)
  const atPrefixed = slice.startsWith('@')
  const m = atPrefixed ? AT_FILE_PATH_AT_RE.exec(slice) : FILE_PATH_AT_RE.exec(slice)
  if (!m) return null
  const full = m[0]
  const path = m[1] ?? ''
  // A non-`@` match that fell through to the extension-less bare-dir branch is
  // only a link when it contains a non-ASCII (CJK) segment; otherwise plain
  // prose like `and/or` or `2024/01/02` would be misread as a directory path.
  if (!atPrefixed && !HAS_KNOWN_EXT_RE.test(full) && !HAS_NON_ASCII_RE.test(path)) return null
  const line = parseInt(m[2] ?? m[4] ?? '', 10) || undefined
  const col = parseInt(m[3] ?? m[5] ?? '', 10) || undefined
  return { full, path, line, col }
}

/**
 * Match when the *entire* string is exactly one file path (plus optional
 * location). Used for backtick-wrapped inline code like `` `src/a.ts` `` — the
 * directory-separator rule still applies, so a bare `` `package.json` `` is not
 * treated as a link.
 */
export function matchFullFilePath(text: string): FilePathMatch | null {
  const m = matchFilePathAt(text, 0)
  return m && m.full === text ? m : null
}

/**
 * True when an explicit markdown-link href (`[x](href)`) looks like a filesystem
 * path rather than a URL. Used to let `[doc](../foo.md)` resolve as a file.
 *
 * Absolute paths (Windows drive `D:/…`/`D:\…` or POSIX-absolute `/…`) count even
 * without a known extension, since the drive prefix / leading slash makes the
 * filesystem intent unambiguous and the target may well be a directory
 * (`[vscode](D:/git_project/vscode)`).
 */
export function looksLikeFilePath(href: string): boolean {
  const atPrefixed = href.startsWith('@')
  const target = stripFilePathLinkPrefix(href)
  // A Windows drive path (`D:\…`) superficially matches the URL-scheme test
  // below (`D:` reads as a scheme), so short-circuit it as a path first.
  if (isWindowsDrivePath(target)) return true
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return false // has a URL scheme
  const { pathWithLocation } = splitFilePathFragment(target)
  if (pathWithLocation.length === 0) return false
  // POSIX-absolute paths (leading `/`) are filesystem paths even without an
  // extension — they too may point at a directory.
  if (pathWithLocation.startsWith('/')) return true
  const pathPattern = atPrefixed
    ? `(?:${WIN_ABS_NO_EXT}|${UNIX_ABS_NO_EXT}|${REL_NO_EXT}|${CJK_REL_SEG}+${EXT})`
    : `(?:${WIN_ABS}|${UNIX_ABS}|${REL}|${CJK_REL_SEG}+${EXT})`
  // Both patterns carry the NAL class (\p{L}\p{N} + lookahead), which needs `u`.
  return new RegExp(`^${pathPattern}${LOC}$`, 'u').test(pathWithLocation)
}

/** Split a `path:line:col` / `path(line,col)` href into its parts. */
export function splitFilePathLocation(href: string): {
  path: string
  line: number | undefined
  col: number | undefined
} {
  const m = new RegExp(`^(.*?)${LOC}$`).exec(href)
  if (!m) return { path: href, line: undefined, col: undefined }
  return {
    path: m[1] ?? href,
    line: parseInt(m[2] ?? m[4] ?? '', 10) || undefined,
    col: parseInt(m[3] ?? m[5] ?? '', 10) || undefined,
  }
}

/** Split an explicit markdown file href into path, optional location, and optional #fragment. */
export function splitFilePathTarget(href: string): FilePathTarget {
  const target = stripFilePathLinkPrefix(href)
  const { pathWithLocation, fragment } = splitFilePathFragment(target)
  const { path, line, col } = splitFilePathLocation(pathWithLocation)
  return {
    path,
    ...(line !== undefined ? { line } : {}),
    ...(col !== undefined ? { col } : {}),
    ...(fragment !== undefined ? { fragment } : {}),
  }
}

function splitFilePathFragment(href: string): {
  readonly pathWithLocation: string
  readonly fragment: string | undefined
} {
  const index = href.indexOf('#')
  if (index === -1) return { pathWithLocation: href, fragment: undefined }
  const fragment = href.slice(index + 1)
  return {
    pathWithLocation: href.slice(0, index),
    fragment: fragment.length > 0 ? fragment : undefined,
  }
}
