/**
 * GFM table formatting and in-table Tab navigation. A table is a contiguous run
 * of lines that all contain a pipe `|`, where the second line is a delimiter row
 * (`---`, `:--`, `--:`, `:-:`). Formatting pads every cell so columns align and
 * normalizes the delimiter row, preserving per-column alignment. Navigation
 * moves the cursor to the next/previous cell (adding a row past the last cell).
 */
import { cursor, range, replaceLine, type EditResult, type Selection } from './textEditing.js'

type Align = 'left' | 'center' | 'right' | 'none'

export interface TableBlock {
  /** First line index (header row). */
  readonly start: number
  /** Last line index (inclusive). */
  readonly end: number
  /** Parsed rows excluding the delimiter row; [0] is the header. */
  readonly rows: string[][]
  readonly aligns: Align[]
}

const DELIM_CELL_RE = /^\s*:?-+:?\s*$/

/** Split a table row into trimmed cells, dropping the leading/trailing empties
 *  produced by edge pipes. */
function splitRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|')) s = s.slice(0, -1)
  // Split on unescaped pipes.
  const cells: string[] = []
  let buf = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!
    if (ch === '\\' && i + 1 < s.length) {
      buf += ch + s[i + 1]!
      i++
      continue
    }
    if (ch === '|') {
      cells.push(buf.trim())
      buf = ''
      continue
    }
    buf += ch
  }
  cells.push(buf.trim())
  return cells
}

function isDelimiterRow(line: string): boolean {
  const cells = splitRow(line)
  return cells.length > 0 && cells.every((c) => DELIM_CELL_RE.test(c))
}

function parseAlign(cell: string): Align {
  const c = cell.trim()
  const left = c.startsWith(':')
  const right = c.endsWith(':')
  if (left && right) return 'center'
  if (right) return 'right'
  if (left) return 'left'
  return 'none'
}

function isTableLine(line: string | undefined): boolean {
  return line !== undefined && line.includes('|') && line.trim().length > 0
}

/** Find the table block containing `lineIndex`, or undefined. */
export function findTableAt(lines: readonly string[], lineIndex: number): TableBlock | undefined {
  if (!isTableLine(lines[lineIndex])) return undefined

  let start = lineIndex
  while (start > 0 && isTableLine(lines[start - 1])) start--
  let end = lineIndex
  while (end < lines.length - 1 && isTableLine(lines[end + 1])) end++

  // Need at least a header + delimiter row, and the second line must be a delimiter.
  if (end - start < 1) return undefined
  const delimLine = lines[start + 1]
  if (delimLine === undefined || !isDelimiterRow(delimLine)) return undefined

  const aligns = splitRow(delimLine).map(parseAlign)
  const rows: string[][] = []
  for (let i = start; i <= end; i++) {
    if (i === start + 1) continue // skip delimiter row
    rows.push(splitRow(lines[i]!))
  }
  return { start, end, rows, aligns }
}

/** Display width: count CJK wide chars as 2 so alignment looks right in a monospace font. */
function cellWidth(text: string): number {
  let w = 0
  for (const ch of text) {
    const code = ch.codePointAt(0)!
    w += code >= 0x1100 && isWide(code) ? 2 : 1
  }
  return w
}

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  )
}

function pad(text: string, width: number, align: Align): string {
  const deficit = width - cellWidth(text)
  if (deficit <= 0) return text
  if (align === 'right') return ' '.repeat(deficit) + text
  if (align === 'center') {
    const left = Math.floor(deficit / 2)
    return ' '.repeat(left) + text + ' '.repeat(deficit - left)
  }
  return text + ' '.repeat(deficit)
}

function delimiterCell(width: number, align: Align): string {
  // Width is the content width; the delimiter fills it with dashes plus colons.
  const w = Math.max(width, align === 'center' ? 3 : align === 'none' ? 1 : 2)
  switch (align) {
    case 'left':
      return ':' + '-'.repeat(Math.max(1, w - 1))
    case 'right':
      return '-'.repeat(Math.max(1, w - 1)) + ':'
    case 'center':
      return ':' + '-'.repeat(Math.max(1, w - 2)) + ':'
    default:
      return '-'.repeat(w)
  }
}

/** Format the table block: align all columns, normalize the delimiter row. */
export function formatTable(lines: readonly string[], lineIndex: number): EditResult | undefined {
  const table = findTableAt(lines, lineIndex)
  if (!table) return undefined

  const colCount = Math.max(table.aligns.length, ...table.rows.map((r) => r.length))
  const aligns: Align[] = []
  for (let c = 0; c < colCount; c++) aligns.push(table.aligns[c] ?? 'none')

  // Column content width is the widest cell across all data rows (min 3 for a
  // readable delimiter).
  const widths: number[] = []
  for (let c = 0; c < colCount; c++) {
    let w = 3
    for (const row of table.rows) w = Math.max(w, cellWidth(row[c] ?? ''))
    widths.push(w)
  }

  const renderRow = (cells: string[]): string => {
    const out: string[] = []
    for (let c = 0; c < colCount; c++) {
      out.push(pad(cells[c] ?? '', widths[c]!, aligns[c]!))
    }
    return '| ' + out.join(' | ') + ' |'
  }
  const renderDelim = (): string => {
    const out: string[] = []
    for (let c = 0; c < colCount; c++) out.push(delimiterCell(widths[c]!, aligns[c]!))
    return '| ' + out.join(' | ') + ' |'
  }

  const edits = []
  let rowIdx = 0
  for (let i = table.start; i <= table.end; i++) {
    const original = lines[i]!
    let next: string
    if (i === table.start + 1) {
      next = renderDelim()
    } else {
      next = renderRow(table.rows[rowIdx]!)
      rowIdx++
    }
    if (next !== original) edits.push(replaceLine(i, original, next))
  }
  return { edits }
}

/** Compute the cursor target for Tab / Shift+Tab inside a table. Returns the new
 *  selection, an optional structural edit (when a new row is appended), or
 *  undefined when the cursor isn't in a table. */
export function navigateTable(
  lines: readonly string[],
  selections: readonly Selection[],
  direction: 'next' | 'prev',
): EditResult | undefined {
  if (selections.length !== 1) return undefined
  const sel = selections[0]!
  const lineIndex = sel.active.line
  const table = findTableAt(lines, lineIndex)
  if (!table) return undefined

  const line = lines[lineIndex]!
  const cellIndex = cellIndexAt(line, sel.active.character)
  const colCount = Math.max(table.aligns.length, ...table.rows.map((r) => r.length))

  if (direction === 'next') {
    if (cellIndex < colCount - 1) {
      return { edits: [], selections: [cellCursor(line, lineIndex, cellIndex + 1)] }
    }
    // Last cell: move to first cell of the next row, skipping the delimiter row.
    let nextLine = lineIndex + 1
    if (nextLine === table.start + 1) nextLine = table.start + 2
    if (nextLine <= table.end) {
      const target = lines[nextLine]!
      return { edits: [], selections: [cellCursor(target, nextLine, 0)] }
    }
    // Past the last row: append a fresh empty row.
    const emptyRow = '|' + ' |'.repeat(colCount)
    const insertAt = table.end
    const text = '\n' + emptyRow
    return {
      edits: [
        {
          range: range(insertAt, lines[insertAt]!.length, insertAt, lines[insertAt]!.length),
          text,
        },
      ],
      selections: [cellCursor(emptyRow, insertAt + 1, 0)],
    }
  }

  // prev
  if (cellIndex > 0) {
    return { edits: [], selections: [cellCursor(line, lineIndex, cellIndex - 1)] }
  }
  let prevLine = lineIndex - 1
  if (prevLine === table.start + 1) prevLine = table.start
  if (prevLine >= table.start) {
    const target = lines[prevLine]!
    return { edits: [], selections: [cellCursor(target, prevLine, colCount - 1)] }
  }
  return { edits: [], selections: [sel] }
}

/** Which cell (0-based) the character offset falls in. */
function cellIndexAt(line: string, character: number): number {
  let idx = 0
  let started = false
  for (let i = 0; i < character && i < line.length; i++) {
    const ch = line[i]!
    if (ch === '\\') {
      i++
      continue
    }
    if (ch === '|') {
      if (started) idx++
      started = true
    }
  }
  // Leading pipe makes the first separator the boundary before cell 0.
  return Math.max(0, idx - (line.trimStart().startsWith('|') ? 0 : 0))
}

/** A cursor placed at the start of the content of cell `target` on `line`. */
function cellCursor(line: string, lineIndex: number, target: number): Selection {
  let col = 0
  let cell = 0
  let i = 0
  // Skip a leading pipe.
  if (line.trimStart().startsWith('|')) {
    i = line.indexOf('|') + 1
  }
  for (; i < line.length; i++) {
    const ch = line[i]!
    if (ch === '\\') {
      i++
      continue
    }
    if (ch === '|') {
      cell++
      if (cell > target) break
      col = i + 1
      continue
    }
  }
  // Position just after the pipe + the single padding space, if present.
  let c = col
  while (c < line.length && line[c] === ' ') c++
  return cursor(lineIndex, c)
}
