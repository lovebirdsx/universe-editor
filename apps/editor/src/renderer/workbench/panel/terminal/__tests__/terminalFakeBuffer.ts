import type {
  TerminalBuffer,
  TerminalBufferCell,
  TerminalBufferLine,
} from '../terminalBufferText.js'

// Fake xterm buffer for exercising the link windowing / index mapping without
// pulling in the real xterm IBuffer. It faithfully reproduces the two contracts
// the upstream mapping relies on:
//   - an empty cell's getChars() is '' while translateToString renders it ' '
//   - getCell(x, cell) writes into the passed cell and returns it
// and lays out CJK chars as 2 cells (first width 2, second width 0) with
// early-wrap when a wide char cannot fit the last column.

export class FakeCell implements TerminalBufferCell {
  chars = ''
  width = 0
  getChars(): string {
    return this.chars
  }
  getWidth(): number {
    return this.width
  }
}

function makeCell(chars: string, width: number): FakeCell {
  const cell = new FakeCell()
  cell.chars = chars
  cell.width = width
  return cell
}

export class FakeLine implements TerminalBufferLine {
  isWrapped = false
  private readonly cells: FakeCell[]
  constructor(cells: FakeCell[]) {
    this.cells = cells
  }
  get length(): number {
    return this.cells.length
  }
  /** The last non-padding cell, for attaching a combining mark across a wrap. */
  lastCell(): FakeCell | undefined {
    for (let i = this.cells.length - 1; i >= 0; i--) {
      const cell = this.cells[i]
      if (cell && cell.chars !== '') return cell
    }
    return undefined
  }
  getCell(x: number, cell?: FakeCell): FakeCell | undefined {
    const src = this.cells[x]
    if (!src) return undefined
    const target = cell ?? new FakeCell()
    target.chars = src.chars
    target.width = src.width
    return target
  }
  translateToString(trimRight = false): string {
    let end = this.cells.length
    if (trimRight) {
      while (end > 0) {
        const tail = this.cells[end - 1]
        if (!tail || tail.chars !== '') break
        end--
      }
    }
    let result = ''
    let i = 0
    while (i < end) {
      const cell = this.cells[i]
      if (!cell) break
      result += cell.chars === '' ? ' ' : cell.chars
      i += cell.width || 1
    }
    return result
  }
}

export class FakeBuffer implements TerminalBuffer {
  private readonly lines: FakeLine[]
  private readonly nullCell = new FakeCell()
  constructor(lines: FakeLine[]) {
    this.lines = lines
  }
  getLine(y: number): FakeLine | undefined {
    return this.lines[y]
  }
  getNullCell(): FakeCell {
    return this.nullCell
  }
}

function charWidth(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0
  return cp > 0x2e7f ? 2 : 1
}

/** True for a combining mark, which xterm stores in the *preceding* cell. */
function isCombining(ch: string): boolean {
  return /\p{Mn}/u.test(ch)
}

function padToCols(cells: FakeCell[], cols: number): void {
  while (cells.length < cols) cells.push(makeCell('', 1))
}

/**
 * Lay a single text out across `cols`-wide wrapped lines (line 1 unwrapped).
 * Combining marks join the previous cell (chars.length > 1, width unchanged),
 * mirroring xterm's `_combined` storage — that is what makes the string index
 * and the cell column diverge without any wide char involved.
 */
export function makeTerminalBuffer(text: string, cols: number): FakeBuffer {
  const lines: FakeLine[] = []
  let current: FakeCell[] = []

  const flush = (): void => {
    padToCols(current, cols)
    lines.push(new FakeLine(current))
    current = []
  }

  for (const ch of text) {
    if (isCombining(ch)) {
      const prev = current[current.length - 1] ?? lines[lines.length - 1]?.lastCell()
      if (prev && prev.chars !== '') {
        prev.chars += ch
        continue
      }
    }
    const width = charWidth(ch)
    const remaining = cols - current.length
    if (width === 2) {
      if (remaining < 2) {
        if (remaining === 1) current.push(makeCell('', 1))
        flush()
      }
      current.push(makeCell(ch, 2))
      current.push(makeCell('', 0))
    } else {
      if (current.length >= cols) flush()
      current.push(makeCell(ch, 1))
    }
  }
  flush()

  lines.forEach((line, i) => {
    line.isWrapped = i > 0
  })
  return new FakeBuffer(lines)
}

/** Build a buffer from explicit lines (ASCII only) with caller-set isWrapped. */
export function makeBufferFromLines(
  lines: Array<{ text: string; isWrapped: boolean }>,
  cols: number,
): FakeBuffer {
  return new FakeBuffer(
    lines.map(({ text, isWrapped }) => {
      const cells = [...text].map((ch) => makeCell(ch, 1))
      padToCols(cells, cols)
      const line = new FakeLine(cells)
      line.isWrapped = isWrapped
      return line
    }),
  )
}
