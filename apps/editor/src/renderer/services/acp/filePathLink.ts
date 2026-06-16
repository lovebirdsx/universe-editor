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

// Segment: non-whitespace, non-quote, non-angle-bracket, no markdown-significant chars.
const SEG = '[^\\s"\'<>|*?()\\[\\]]'

// Windows absolute:   C:\path\file.ts  or  C:/path/file.ts
const WIN_ABS = `[A-Za-z]:[/\\\\](?:${SEG}+[/\\\\])*${SEG}+${EXT}`
// Unix absolute or relative dot-slash:  /path/file.ts  ./path/file.ts  ../path/file.ts
const UNIX_ABS = `\\.{0,2}/(?:${SEG}+/)*${SEG}+${EXT}`
// Relative with at least one dir component:  src/foo/bar.ts
const REL = `(?:[^\\s"'<>|*?:()\\[\\]/\\\\]+[/\\\\])+[^\\s"'<>|*?:()\\[\\]/\\\\]+${EXT}`

// Optional :line:col  or  (line,col)
const LOC = `(?::(\\d+)(?::(\\d+))?|\\((\\d+)(?:,(\\d+))?\\))?`

/** The path-with-optional-location pattern, for reuse (e.g. the terminal link provider). */
export const FILE_PATH_PATTERN = `(${WIN_ABS}|${UNIX_ABS}|${REL})${LOC}`

// Anchored at the start of a slice so callers can probe position-by-position.
const FILE_PATH_AT_RE = new RegExp(`^${FILE_PATH_PATTERN}`)

export interface FilePathMatch {
  /** Full matched text including any location suffix. */
  readonly full: string
  /** The path portion (no location suffix). */
  readonly path: string
  readonly line: number | undefined
  readonly col: number | undefined
}

/**
 * Try to match a file path anchored at index {@link i} of {@link text}. Returns
 * `null` when no path starts there. Mirrors the inline parser's left-to-right
 * scan so it runs once per character at most.
 */
export function matchFilePathAt(text: string, i: number): FilePathMatch | null {
  // Avoid matching mid-token (e.g. the `src/a.ts` inside `xsrc/a.ts`).
  if (i > 0 && /[A-Za-z0-9_]/.test(text[i - 1] ?? '')) return null
  const m = FILE_PATH_AT_RE.exec(text.slice(i))
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
  if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return false // has a URL scheme
  return new RegExp(`^(?:${WIN_ABS}|${UNIX_ABS}|${REL}|${SEG}+${EXT})$`).test(href)
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
