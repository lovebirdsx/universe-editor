/**
 * Toggle GFM task-list checkboxes on every line the selection touches. A line
 * that is a list item gets a checkbox added if it lacks one; an existing checkbox
 * toggles between `[ ]` and `[x]`. With a multi-line selection, the whole block
 * is driven by the first checkable line's target state, so a mixed block becomes
 * uniformly checked (matching MAIO's batch behavior).
 */
import { replaceLine, type EditResult, type Selection } from './textEditing.js'

// Capture: indent, bullet marker (-, *, +, or `1.`), existing checkbox, rest.
const TASK_RE = /^(\s*)([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?(.*)$/

interface Parsed {
  indent: string
  marker: string
  checkbox: string | undefined
  rest: string
}

function parse(line: string): Parsed | undefined {
  const m = TASK_RE.exec(line)
  if (!m) return undefined
  return { indent: m[1]!, marker: m[2]!, checkbox: m[3], rest: m[4]! }
}

function isChecked(checkbox: string): boolean {
  return /\[[xX]\]/.test(checkbox)
}

function render(p: Parsed, checked: boolean): string {
  return `${p.indent}${p.marker} [${checked ? 'x' : ' '}] ${p.rest}`
}

export function toggleTask(lines: readonly string[], selections: readonly Selection[]): EditResult {
  const edits = []
  const seen = new Set<number>()
  let target: boolean | undefined

  for (const sel of selections) {
    const startLine = Math.min(sel.anchor.line, sel.active.line)
    const endLine = Math.max(sel.anchor.line, sel.active.line)
    for (let i = startLine; i <= endLine; i++) {
      if (seen.has(i)) continue
      seen.add(i)
      const line = lines[i]
      if (line === undefined) continue
      const p = parse(line)
      if (!p) continue
      // First checkable line decides the block's target: if it has an unchecked
      // box (or none), we check the block; if checked, we uncheck.
      if (target === undefined) {
        target = !(p.checkbox !== undefined && isChecked(p.checkbox))
      }
      const next = render(p, target)
      if (next !== line) edits.push(replaceLine(i, line, next))
    }
  }
  return { edits }
}
