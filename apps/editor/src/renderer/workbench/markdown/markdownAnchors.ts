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
  const id = decodeMarkdownAnchor(anchor)
  if (!id) return null
  return root.querySelector(`[data-anchor="${cssEscape(id)}"]`)
}

function cssEscape(value: string): string {
  const esc = (globalThis.CSS as { escape?: (v: string) => string } | undefined)?.escape
  return esc ? esc(value) : value.replace(/["\\]/g, '\\$&')
}
