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
// non-ASCII char (CJK text + full-width punctuation). Excluding these stops a
// bare path from crossing an inline-code boundary or swallowing the surrounding
// prose — the false positives we used to see in mixed Chinese/code sentences.
const NON_SEG = '\\s\\x00-\\x1f"\'`<>|*?,;{}()\\[\\]\\u0080-\\uffff'
// Segment for absolute paths (may contain ':' only via the Windows drive prefix,
// which is matched separately; a ':' here would be the start of a :line suffix).
const SEG = `[^${NON_SEG}]`
// Segment for the relative grammar: additionally bars the path separators and
// ':' so a segment can't span a directory boundary or eat the location suffix.
const REL_SEG = `[^${NON_SEG}:/\\\\]`

// Windows absolute:   C:\path\file.ts  or  C:/path/file.ts
const WIN_ABS = `[A-Za-z]:[/\\\\](?:${SEG}+[/\\\\])*${SEG}+${EXT}`
// Unix absolute or relative dot-slash:  /path/file.ts  ./path/file.ts  ../path/file.ts
const UNIX_ABS = `\\.{0,2}/(?:${SEG}+/)*${SEG}+${EXT}`
// Relative with at least one dir component:  src/foo/bar.ts
const REL = `(?:${REL_SEG}+[/\\\\])+${REL_SEG}+${EXT}`
// @-prefixed mentions are explicit file references, so they may omit a known extension.
const WIN_ABS_NO_EXT = `[A-Za-z]:[/\\\\](?:${SEG}+[/\\\\])*${SEG}+`
const UNIX_ABS_NO_EXT = `\\.{0,2}/(?:${SEG}+/)*${SEG}+`
const REL_NO_EXT = `(?:${REL_SEG}+[/\\\\])+${REL_SEG}+`

// Optional :line:col  or  (line,col)
const LOC = `(?::(\\d+)(?::(\\d+))?|\\((\\d+)(?:,(\\d+))?\\))?`

/** The path-with-optional-location pattern, for reuse (e.g. the terminal link provider). */
export const FILE_PATH_PATTERN = `(${WIN_ABS}|${UNIX_ABS}|${REL})${LOC}`

// Anchored at the start of a slice so callers can probe position-by-position.
const FILE_PATH_AT_RE = new RegExp(`^${FILE_PATH_PATTERN}`)
const AT_FILE_PATH_AT_RE = new RegExp(
  `^@(${WIN_ABS_NO_EXT}|${UNIX_ABS_NO_EXT}|${REL_NO_EXT})${LOC}`,
)

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

/**
 * Try to match a file path anchored at index {@link i} of {@link text}. Returns
 * `null` when no path starts there. Mirrors the inline parser's left-to-right
 * scan so it runs once per character at most.
 */
export function matchFilePathAt(text: string, i: number): FilePathMatch | null {
  // Avoid matching mid-token (e.g. the `src/a.ts` inside `xsrc/a.ts`).
  if (i > 0 && /[A-Za-z0-9_]/.test(text[i - 1] ?? '')) return null
  const slice = text.slice(i)
  const atPrefixed = slice.startsWith('@')
  const m = atPrefixed ? AT_FILE_PATH_AT_RE.exec(slice) : FILE_PATH_AT_RE.exec(slice)
  if (!m) return null
  const full = m[0]
  const path = m[1] ?? ''
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
 */
export function looksLikeFilePath(href: string): boolean {
  const atPrefixed = href.startsWith('@')
  const target = stripFilePathLinkPrefix(href)
  if (/^[a-z][a-z0-9+.-]*:/i.test(target)) return false // has a URL scheme
  const { pathWithLocation } = splitFilePathFragment(target)
  if (pathWithLocation.length === 0) return false
  const pathPattern = atPrefixed
    ? `(?:${WIN_ABS_NO_EXT}|${UNIX_ABS_NO_EXT}|${REL_NO_EXT}|${REL_SEG}+${EXT})`
    : `(?:${WIN_ABS}|${UNIX_ABS}|${REL}|${REL_SEG}+${EXT})`
  return new RegExp(`^${pathPattern}${LOC}$`).test(pathWithLocation)
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
