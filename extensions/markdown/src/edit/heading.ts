/**
 * Increase or decrease the ATX heading level of the lines touched by the
 * selection. Increase: add a `#` (plain line → `# `, `###### ` caps at 6).
 * Decrease: remove one `#` (`# text` → `text`). Operates on every line in the
 * selection's line span so a multi-line selection re-levels as a block.
 */
import { replaceLine, type EditResult, type Selection } from './textEditing.js'

const HEADING_RE = /^(#{1,6})(\s+)(.*)$/

function bumpLine(line: string, delta: number): string | undefined {
  const m = HEADING_RE.exec(line)
  if (m) {
    const level = m[1]!.length
    const next = level + delta
    if (next <= 0) return m[3]! // strip heading entirely
    if (next > 6) return undefined // already maxed; no change
    return '#'.repeat(next) + ' ' + m[3]!
  }
  // Not currently a heading.
  if (delta > 0) return '# ' + line.replace(/^\s+/, '')
  return undefined // can't decrease a non-heading
}

export function changeHeadingLevel(
  lines: readonly string[],
  selections: readonly Selection[],
  delta: number,
): EditResult {
  const sel = selections[0]
  if (!sel) return { edits: [] }
  const startLine = Math.min(sel.anchor.line, sel.active.line)
  const endLine = Math.max(sel.anchor.line, sel.active.line)

  const edits = []
  for (let i = startLine; i <= endLine; i++) {
    const line = lines[i]
    if (line === undefined) continue
    const next = bumpLine(line, delta)
    if (next !== undefined && next !== line) edits.push(replaceLine(i, line, next))
  }
  return { edits }
}
