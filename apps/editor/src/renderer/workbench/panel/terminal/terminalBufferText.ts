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

export function mapStringIndexToCell(
  buffer: TerminalBuffer,
  lineIndex: number,
  cellIndex: number,
  stringIndex: number,
): { y: number; x: number } | null {
  const cell = buffer.getNullCell()
  let start = cellIndex
  while (stringIndex) {
    const line = buffer.getLine(lineIndex)
    if (!line) {
      return null
    }
    for (let i = start; i < line.length; ++i) {
      line.getCell(i, cell)
      const chars = cell.getChars()
      const width = cell.getWidth()
      if (width) {
        stringIndex -= chars.length || 1
        // Correct for early-wrapped wide chars: a wide char that didn't fit the
        // last cell wraps to the next line, leaving this trailing cell empty
        // (width 1) but trimmed out of the window string by trimRight.
        if (i === line.length - 1 && chars === '') {
          const next = buffer.getLine(lineIndex + 1)
          if (next && next.isWrapped) {
            next.getCell(0, cell)
            if (cell.getWidth() === 2) {
              stringIndex += 1
            }
          }
        }
      }
      if (stringIndex < 0) {
        return { y: lineIndex, x: i }
      }
    }
    lineIndex++
    start = 0
  }
  return { y: lineIndex, x: start }
}
