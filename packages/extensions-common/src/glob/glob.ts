/**
 * Extension-surface glob utilities. The glob → RegExp engine itself lives in
 * platform and is re-exported below so the extension runtime surfaces
 * (renderer `MainThread*`, ext host) and the `RelativePattern` helpers here
 * share one compiler. Match semantics (workspace-relative, forward-slash
 * path): `*` stays within a segment, `**` crosses segments (in the
 * slash-suffixed form it also matches zero segments), `?` matches one
 * non-separator character, `{a,b}` alternates
 * with alternatives compiled as glob fragments, `[...]` is a character class
 * with `!`/`^` negation, and a slashless pattern matches the basename at ANY
 * depth (ripgrep `-g` style). Matching is case-sensitive on every platform.
 */
import { basename, dirname } from '@universe-editor/platform'

export { compileGlobMatcher, normalizeExtensionGlobPattern } from '@universe-editor/platform'

const HAS_GLOB_CHARS = /[*?{[]/

/**
 * Split an absolute glob into its literal root folder and the remaining
 * base-relative pattern (VSCode RelativePattern semantics), or null when the
 * pattern is workspace-relative. A glob-free absolute path targets a single
 * entry: base is its parent folder, pattern its basename. A bare filesystem
 * root (`/x`, `D:/x`) cannot anchor a watch and splits to null.
 */
export function splitAbsoluteGlob(pattern: string): { base: string; pattern: string } | null {
  const normalized = pattern.replace(/\\/g, '/')
  const anchored =
    normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized) || normalized.startsWith('//')
  if (!anchored) return null
  const segments = normalized.split('/')
  const cut = segments.findIndex((s) => HAS_GLOB_CHARS.test(s))
  if (cut === -1) {
    if (normalized.endsWith('/')) return null
    const base = dirname(normalized)
    const rest = basename(normalized)
    if (base === '.' || base === '/' || /^[A-Za-z]:\/?$/.test(base) || rest === '') return null
    return { base, pattern: rest }
  }
  // The glob-bearing tail must have a literal segment above it: everything
  // before the first glob character anchors the base, verbatim.
  if (cut <= 0) return null
  const base = segments.slice(0, cut).join('/')
  const rest = segments.slice(cut).join('/')
  if (base === '' || /^[A-Za-z]:$/.test(base) || rest === '') return null
  return { base, pattern: rest }
}
