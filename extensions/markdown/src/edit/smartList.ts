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
 * Recompute ordered numbering over `working` (the lines after the structural
 * change is applied in memory), then diff the result against the original lines.
 * Diffing keeps every edit in the *original* document's coordinate space — the
 * structural change and the renumbering can disagree on line indices once a line
 * is inserted/removed, so emitting them separately would corrupt the document.
 */
function withRenumber(
  lines: readonly string[],
  working: string[],
  selections: Selection[],
): EditResult {
  const final = [...working]
  for (const e of renumberOrderedLists(working)) final[e.range.start.line] = e.text
  return { edits: diffLineEdits(lines, final), selections }
}

/**
 * Minimal line-level diff: shrink the common prefix/suffix, then replace the
 * differing middle as one edit. Handles replacement, insertion, and deletion
 * uniformly, always in the original document's coordinates.
 */
function diffLineEdits(original: readonly string[], final: readonly string[]): EditOp[] {
  let p = 0
  const maxPrefix = Math.min(original.length, final.length)
  while (p < maxPrefix && original[p] === final[p]) p++
  let s = 0
  while (
    s < Math.min(original.length - p, final.length - p) &&
    original[original.length - 1 - s] === final[final.length - 1 - s]
  ) {
    s++
  }

  const origStart = p
  const origEnd = original.length - s // exclusive
  const newLines = final.slice(p, final.length - s)

  if (origStart === origEnd && newLines.length === 0) return []

  // Replace the consumed original lines [origStart, origEnd) with newLines.
  if (origEnd > origStart) {
    const last = origEnd - 1
    return [{ range: range(origStart, 0, last, original[last]!.length), text: newLines.join('\n') }]
  }

  // Pure insertion: no original lines consumed.
  if (origStart < original.length) {
    return [{ range: range(origStart, 0, origStart, 0), text: newLines.join('\n') + '\n' }]
  }
  const last = original.length - 1
  return [
    {
      range: range(last, original[last]!.length, last, original[last]!.length),
      text: '\n' + newLines.join('\n'),
    },
  ]
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

  // Cursor at the very start of a list line → don't continue the list; insert a
  // blank line above and push the item down, matching a plain line's Enter.
  if (col === 0) {
    const working = [...lines]
    working.splice(lineIndex, 0, '')
    return withRenumber(lines, working, [cursor(lineIndex + 1, 0)])
  }

  // Empty item → exit the list: clear the marker, leave a blank line.
  if (isEmptyItem(parsed)) {
    const working = [...lines]
    working[lineIndex] = ''
    return withRenumber(lines, working, [cursor(lineIndex, 0)])
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

  const newCursor = cursor(lineIndex + 1, prefix.length)
  return withRenumber(lines, working, [newCursor])
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
  for (const { index, line, parsed } of parsedLines) {
    let newLine: string
    if (direction === 'indent') {
      newLine = INDENT_UNIT + line
    } else {
      const remove = Math.min(INDENT_UNIT.length, parsed.indent.length)
      newLine = line.slice(remove)
    }
    working[index] = newLine
  }

  // Preserve the cursor relative to the indent change.
  const shift =
    direction === 'indent'
      ? INDENT_UNIT.length
      : -Math.min(INDENT_UNIT.length, parsedLines[0]!.parsed.indent.length)
  const selOut: Selection[] = isPoint
    ? [cursor(sel.active.line, Math.max(0, sel.active.character + shift))]
    : selections.slice()
  return withRenumber(lines, working, selOut)
}
