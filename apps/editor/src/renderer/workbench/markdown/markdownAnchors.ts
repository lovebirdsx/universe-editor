import { slugifyHeading } from '../../services/acp/markdownRenderer.js'

export function decodeMarkdownAnchor(anchor: string): string {
  const raw = anchor.startsWith('#') ? anchor.slice(1) : anchor
  let decoded = raw
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    // Malformed %-escape: fall back to the raw fragment.
  }
  return slugifyHeading(decoded)
}

export function findMarkdownAnchor(root: ParentNode, anchor: string): Element | null {
  const raw = anchor.startsWith('#') ? anchor.slice(1) : anchor
  let decoded = raw
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    // Malformed %-escape: fall back to the raw fragment.
  }
  if (!decoded) return null
  // 1. Exact match — html <a id>/<a name> targets (and headings whose slug is
  //    already the fragment). HTML ids are case-sensitive; never slugify first.
  const exact = root.querySelector(`[data-anchor="${cssEscape(decoded)}"]`)
  if (exact) return exact
  // 2. Heading-slug fallback — GitHub-style #frag written against a heading.
  const slug = slugifyHeading(decoded)
  if (!slug || slug === decoded) return null
  return root.querySelector(`[data-anchor="${cssEscape(slug)}"]`)
}

function cssEscape(value: string): string {
  const esc = (globalThis.CSS as { escape?: (v: string) => string } | undefined)?.escape
  return esc ? esc(value) : value.replace(/["\\]/g, '\\$&')
}
