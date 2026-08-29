// Minimal structural views of the xterm buffer types, so tests can feed a fake
// buffer without casting to xterm's IBuffer. Method members match exactly the
// subset of xterm.d.ts used by readWrappedWindow / mapStringIndexToCell.

export interface TerminalBufferCell {
  getWidth(): number
  getChars(): string
}

export interface TerminalBufferLine {
  readonly isWrapped: boolean
  readonly length: number
  getCell(x: number, cell?: TerminalBufferCell): TerminalBufferCell | undefined
  translateToString(trimRight?: boolean): string
}

export interface TerminalBuffer {
  getLine(y: number): TerminalBufferLine | undefined
  getNullCell(): TerminalBufferCell
}

export interface WrappedWindow {
  text: string
  startLineIndex: number
}

const MAX_WINDOW_LENGTH = 2048

export function readWrappedWindow(buffer: TerminalBuffer, lineIndex: number): WrappedWindow {
  let line: TerminalBufferLine | undefined
  let topIdx = lineIndex
  let bottomIdx = lineIndex
  // The index of the topmost line actually joined into `text`. It trails topIdx
  // because the `--topIdx` in the loop condition also runs on the iteration that
  // fails the length cap; reporting topIdx there would name a line the caller
  // never sees, shifting every mapped coordinate by one line.
  let firstIdx = lineIndex
  let length = 0
  let content = ''
  const lines: string[] = []

  if ((line = buffer.getLine(lineIndex))) {
    const currentContent = line.translateToString(true)

    if (line.isWrapped && currentContent[0] !== ' ') {
      length = 0
      while ((line = buffer.getLine(--topIdx)) && length < MAX_WINDOW_LENGTH) {
        content = line.translateToString(true)
        length += content.length
        lines.push(content)
        firstIdx = topIdx
        if (!line.isWrapped || content.indexOf(' ') !== -1) {
          break
        }
      }
      lines.reverse()
    }

    lines.push(currentContent)

    length = 0
    while ((line = buffer.getLine(++bottomIdx)) && line.isWrapped && length < MAX_WINDOW_LENGTH) {
      content = line.translateToString(true)
      length += content.length
      lines.push(content)
      if (content.indexOf(' ') !== -1) {
        break
      }
    }
  }
  return { text: lines.join(''), startLineIndex: firstIdx }
}

/**
 * Columns that `translateToString(true)` actually renders, i.e. one past the
 * last column holding a character. The window string is joined from trimmed
 * rows, so the walk below has to stop at the same place — a trailing blank cell
 * contributed nothing to the string and must not consume from it. Mirrors
 * xterm's own `BufferLine.getTrimmedLength`, including counting a trailing wide
 * char as the two columns it occupies.
 */
function trimmedLength(line: TerminalBufferLine, cell: TerminalBufferCell): number {
  for (let i = line.length - 1; i >= 0; i--) {
    line.getCell(i, cell)
    if (cell.getChars() !== '') return i + (cell.getWidth() || 1)
  }
  return 0
}

/**
 * What the caller is locating, which is the only thing that decides where a
 * string index landing exactly on a row's content boundary belongs.
 *
 * `'char'` looks for a real character: it lives at the next wrapped row's
 * column 0, so the walk falls through.
 * `'exclusiveEnd'` looks for the position one past the last character: that is
 * this row's own boundary column. Falling through would report column 0 of the
 * next row, which xterm renders as an underline stretching across all of this
 * row's padding to its edge.
 */
export type CellTarget = 'char' | 'exclusiveEnd'

export function mapStringIndexToCell(
  buffer: TerminalBuffer,
  lineIndex: number,
  cellIndex: number,
  stringIndex: number,
  target: CellTarget = 'char',
): { y: number; x: number } | null {
  const cell = buffer.getNullCell()
  let start = cellIndex
  while (stringIndex) {
    const line = buffer.getLine(lineIndex)
    if (!line) {
      return null
    }
    const trimmed = trimmedLength(line, cell)
    for (let i = start; i < trimmed; ++i) {
      line.getCell(i, cell)
      const chars = cell.getChars()
      if (cell.getWidth()) {
        stringIndex -= chars.length || 1
      }
      if (stringIndex < 0) {
        return { y: lineIndex, x: i }
      }
    }
    // Exhausted this row's content with the index landing exactly on the
    // boundary; `target` decides whether that position is this row's boundary
    // column or the next row's column 0. On a row with no padding the boundary
    // column is one past the last cell, which IS the next row's column 0, so
    // falling through is correct for both targets there.
    if (stringIndex === 0 && trimmed < line.length) {
      const next = buffer.getLine(lineIndex + 1)
      if (target === 'exclusiveEnd' || !next?.isWrapped) {
        return { y: lineIndex, x: trimmed }
      }
    }
    lineIndex++
    start = 0
  }
  return { y: lineIndex, x: start }
}
