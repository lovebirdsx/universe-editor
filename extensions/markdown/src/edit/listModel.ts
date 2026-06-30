/**
 * List-line parsing shared by smart Enter / Tab / renumber. A list line is a
 * sequence of: indent, a marker (`-`/`*`/`+` or `<n>.`/`<n>)`), optional task
 * checkbox, then content. `contentColumn` is the character offset where the
 * content starts (the column a wrapped/continued line should align to).
 */

export interface ListMarker {
  /** Leading whitespace before the marker. */
  readonly indent: string
  /** The bullet (`-`, `*`, `+`) or the ordered number text (e.g. `12`). */
  readonly marker: string
  /** True for ordered markers (`1.`); false for bullets. */
  readonly ordered: boolean
  /** The delimiter after an ordered number: `.` or `)`. Empty for bullets. */
  readonly delim: string
  /** The whitespace between marker and content (usually a single space). */
  readonly spaceAfter: string
  /** Task checkbox text including trailing space, e.g. `[ ] `; empty if none. */
  readonly checkbox: string
  /** The content after the marker (and checkbox). */
  readonly content: string
  /** Column where content begins (0-based). */
  readonly contentColumn: number
}

const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)(\[[ xX]\]\s+)?(.*)$/

export function parseListMarker(line: string): ListMarker | undefined {
  const m = LIST_RE.exec(line)
  if (!m) return undefined
  const indent = m[1]!
  const rawMarker = m[2]!
  const spaceAfter = m[3]!
  const checkbox = m[4] ?? ''
  const content = m[5]!
  const ordered = /\d/.test(rawMarker)
  const delim = ordered ? rawMarker.slice(-1) : ''
  const marker = ordered ? rawMarker.slice(0, -1) : rawMarker
  const contentColumn = indent.length + rawMarker.length + spaceAfter.length + checkbox.length
  return { indent, marker, ordered, delim, spaceAfter, checkbox, content, contentColumn }
}

/** Render a marker's prefix (everything up to and including the space/checkbox). */
export function renderPrefix(m: {
  indent: string
  ordered: boolean
  marker: string
  delim: string
  spaceAfter: string
  checkbox: string
}): string {
  const core = m.ordered ? `${m.marker}${m.delim}` : m.marker
  return `${m.indent}${core}${m.spaceAfter}${m.checkbox}`
}

/** True when the line is a list item whose content is empty (an "open" item). */
export function isEmptyItem(m: ListMarker): boolean {
  return m.content.trim().length === 0
}
