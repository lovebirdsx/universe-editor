/**
 * Smart list behaviors: Enter continues / exits a list item, Tab indents and
 * Shift+Tab outdents a list item. Pure computation over lines + selections; the
 * command layer fetches/applies and decides the fallback. Returns `'default'`
 * when the keystroke isn't a list operation, so the caller does the plain thing.
 */
import { isEmptyItem, parseListMarker, renderPrefix } from './listModel.js'
import { renumberOrderedLists } from './renumber.js'
import { cursor, range, type EditOp, type EditResult, type Selection } from './textEditing.js'

/** One indent level. Matches the editor's `tabSize: 2, insertSpaces: true`. */
export const INDENT_UNIT = '  '

export type SmartResult = EditResult | 'default'

function nextOrderedMarker(marker: string): string {
  const n = Number.parseInt(marker, 10)
  return Number.isFinite(n) ? String(n + 1) : marker
}

/**
 * Apply `lineEdit` to the in-memory lines and recompute ordered numbering, so the
 * returned edits include both the structural change and any renumbering it
 * triggers. `lineEdits` are full-line replacements/insertions already applied to
 * `working`.
 */
function withRenumber(
  working: string[],
  structural: EditOp[],
  selections: Selection[],
): EditResult {
  const renumberEdits = renumberOrderedLists(working)
  return { edits: [...structural, ...renumberEdits], selections }
}

export function computeSmartEnter(
  lines: readonly string[],
  selections: readonly Selection[],
): SmartResult {
  if (selections.length !== 1) return 'default'
  const sel = selections[0]!
  if (sel.anchor.line !== sel.active.line || sel.anchor.character !== sel.active.character) {
    return 'default'
  }
  const lineIndex = sel.active.line
  const line = lines[lineIndex]
  if (line === undefined) return 'default'
  const parsed = parseListMarker(line)
  if (!parsed) return 'default'

  const col = sel.active.character

  // Empty item → exit the list: clear the marker, leave a blank line.
  if (isEmptyItem(parsed)) {
    const working = [...lines]
    working[lineIndex] = ''
    const structural: EditOp[] = [{ range: range(lineIndex, 0, lineIndex, line.length), text: '' }]
    return withRenumber(working, structural, [cursor(lineIndex, 0)])
  }

  // Continue the list: split content at the cursor, start a new item below.
  const before = line.slice(0, col)
  const after = line.slice(col)
  const nextMarker = parsed.ordered ? nextOrderedMarker(parsed.marker) : parsed.marker
  // A task item continues as an unchecked task; a plain item keeps no checkbox.
  const nextCheckbox = parsed.checkbox ? '[ ] ' : ''
  const prefix = renderPrefix({
    indent: parsed.indent,
    ordered: parsed.ordered,
    marker: nextMarker,
    delim: parsed.delim,
    spaceAfter: parsed.spaceAfter,
    checkbox: nextCheckbox,
  })
  const newLineText = prefix + after

  const working = [...lines]
  working[lineIndex] = before
  working.splice(lineIndex + 1, 0, newLineText)

  const structural: EditOp[] = [
    { range: range(lineIndex, col, lineIndex, line.length), text: '\n' + prefix },
  ]
  const newCursor = cursor(lineIndex + 1, prefix.length)
  return withRenumber(working, structural, [newCursor])
}

/** Tab on a list item: indent it. Returns 'default' when not a single-cursor list op. */
export function computeIndent(
  lines: readonly string[],
  selections: readonly Selection[],
): SmartResult {
  return computeShift(lines, selections, 'indent')
}

/** Shift+Tab on a list item: outdent it. */
export function computeOutdent(
  lines: readonly string[],
  selections: readonly Selection[],
): SmartResult {
  return computeShift(lines, selections, 'outdent')
}

function computeShift(
  lines: readonly string[],
  selections: readonly Selection[],
  direction: 'indent' | 'outdent',
): SmartResult {
  if (selections.length !== 1) return 'default'
  const sel = selections[0]!
  const isPoint =
    sel.anchor.line === sel.active.line && sel.anchor.character === sel.active.character

  const startLine = Math.min(sel.anchor.line, sel.active.line)
  const endLine = Math.max(sel.anchor.line, sel.active.line)

  // Every touched line must be a list item for this to be a list shift; a point
  // cursor must additionally sit at or before the content column (Tab elsewhere
  // inserts a literal indent, the editor's job).
  const parsedLines = []
  for (let i = startLine; i <= endLine; i++) {
    const line = lines[i]
    if (line === undefined) return 'default'
    const parsed = parseListMarker(line)
    if (!parsed) return 'default'
    parsedLines.push({ index: i, line, parsed })
  }
  if (isPoint) {
    const only = parsedLines[0]!
    if (sel.active.character > only.parsed.contentColumn) return 'default'
  }

  if (direction === 'outdent') {
    const anyIndented = parsedLines.some((p) => p.parsed.indent.length > 0)
    if (!anyIndented) return 'default'
  }

  const working = [...lines]
  const structural: EditOp[] = []
  for (const { index, line, parsed } of parsedLines) {
    let newLine: string
    if (direction === 'indent') {
      newLine = INDENT_UNIT + line
    } else {
      const remove = Math.min(INDENT_UNIT.length, parsed.indent.length)
      newLine = line.slice(remove)
    }
    working[index] = newLine
    structural.push({ range: range(index, 0, index, line.length), text: newLine })
  }

  // Preserve the cursor relative to the indent change.
  const shift =
    direction === 'indent'
      ? INDENT_UNIT.length
      : -Math.min(INDENT_UNIT.length, parsedLines[0]!.parsed.indent.length)
  const selOut: Selection[] = isPoint
    ? [cursor(sel.active.line, Math.max(0, sel.active.character + shift))]
    : selections.slice()
  return withRenumber(working, structural, selOut)
}
