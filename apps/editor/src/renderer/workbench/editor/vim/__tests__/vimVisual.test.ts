/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { toLineReader } from '../vimMotions.js'
import type { VimPosition } from '../vimTypes.js'
import {
  blockInsertPositions,
  selectionFromExtent,
  visualEolAfterMotion,
  visualExtent,
  visualMonacoSelections,
  visualOperatorRange,
  type VimVisualSelection,
} from '../vimVisual.js'

const at = (line: number, column: number): VimPosition => ({ line, column })

function selection(
  mode: VimVisualSelection['mode'],
  anchor: VimPosition,
  cursor: VimPosition,
  eol?: boolean,
): VimVisualSelection {
  return { mode, anchor, cursor, ...(eol === undefined ? {} : { eol }) }
}

const box = (startLine: number, startColumn: number, endLine: number, endColumn: number) => ({
  startLineNumber: startLine,
  startColumn,
  endLineNumber: endLine,
  endColumn,
})

describe('visualOperatorRange: characterwise', () => {
  const lines = toLineReader(['hello', 'world', 'x'])

  it('includes the character under the far end', () => {
    expect(visualOperatorRange(lines, selection('visual', at(1, 2), at(1, 4))).range).toEqual(
      box(1, 2, 1, 5),
    )
  })

  it('is the same range for a backward selection (the cursor before the anchor)', () => {
    expect(visualOperatorRange(lines, selection('visual', at(1, 4), at(1, 2))).range).toEqual(
      box(1, 2, 1, 5),
    )
    expect(visualOperatorRange(lines, selection('visual', at(2, 2), at(1, 4))).range).toEqual(
      box(1, 4, 2, 3),
    )
  })

  it('takes a single character when anchor and cursor coincide', () => {
    expect(visualOperatorRange(lines, selection('visual', at(1, 3), at(1, 3))).range).toEqual(
      box(1, 3, 1, 4),
    )
  })

  it('selecting an empty line takes its line break, except on the last line', () => {
    const withBlank = toLineReader(['a', '', 'b', ''])
    expect(visualOperatorRange(withBlank, selection('visual', at(2, 1), at(2, 1))).range).toEqual(
      box(2, 1, 3, 1),
    )
    expect(visualOperatorRange(withBlank, selection('visual', at(4, 1), at(4, 1))).range).toEqual(
      box(4, 1, 4, 1),
    )
  })

  it('takes whole lines for a forced linewise action (X / Y)', () => {
    const range = visualOperatorRange(lines, selection('visual', at(1, 3), at(2, 2)), {
      linewise: true,
    })
    expect(range.linewise).toBe(true)
    expect(range.range).toEqual(box(1, 1, 3, 1))
  })
})

describe('visualOperatorRange: sticky $ (v$)', () => {
  const lines = toLineReader(['abc', 'def', 'g'])

  it('includes the line break so v$y yanks it and v$d joins the next line', () => {
    expect(visualOperatorRange(lines, selection('visual', at(1, 2), at(1, 3), true)).range).toEqual(
      box(1, 2, 2, 1),
    )
  })

  it('has no break to take on the last line', () => {
    expect(visualOperatorRange(lines, selection('visual', at(3, 1), at(3, 1), true)).range).toEqual(
      box(3, 1, 3, 2),
    )
  })

  it('applies when the selection spans lines and the cursor leads', () => {
    expect(visualOperatorRange(lines, selection('visual', at(1, 2), at(2, 3), true)).range).toEqual(
      box(1, 2, 3, 1),
    )
  })

  it('is ignored while the cursor is the earlier end', () => {
    expect(visualOperatorRange(lines, selection('visual', at(2, 2), at(1, 1), true)).range).toEqual(
      box(1, 1, 2, 3),
    )
  })

  it('paints the break in the Monaco selection', () => {
    expect(visualMonacoSelections(lines, selection('visual', at(1, 2), at(1, 3), true))).toEqual([
      {
        selectionStartLineNumber: 1,
        selectionStartColumn: 2,
        positionLineNumber: 2,
        positionColumn: 1,
      },
    ])
  })

  it('makes every block row run to its own end', () => {
    const ragged = toLineReader(['abcdef', 'ab', 'abcd'])
    const range = visualOperatorRange(ragged, selection('visual-block', at(1, 2), at(3, 2), true))
    expect(range.blocks).toEqual([box(1, 2, 1, 7), box(2, 2, 2, 3), box(3, 2, 3, 5)])
  })

  it('is kept by vertical motions, set by $ and dropped by anything else', () => {
    expect(visualEolAfterMotion(false, '$')).toBe(true)
    expect(visualEolAfterMotion(true, 'j')).toBe(true)
    expect(visualEolAfterMotion(true, 'k')).toBe(true)
    expect(visualEolAfterMotion(true, 'halfPageDown')).toBe(true)
    expect(visualEolAfterMotion(true, 'h')).toBe(false)
    expect(visualEolAfterMotion(true, 'w')).toBe(false)
    expect(visualEolAfterMotion(true, 'G')).toBe(false)
    expect(visualEolAfterMotion(false, 'j')).toBe(false)
  })
})

describe('visualOperatorRange: linewise and block', () => {
  it('visual-line takes whole lines whichever end leads', () => {
    const lines = toLineReader(['a', 'b', 'c'])
    const forward = visualOperatorRange(lines, selection('visual-line', at(1, 1), at(2, 1)))
    const backward = visualOperatorRange(lines, selection('visual-line', at(2, 1), at(1, 1)))
    expect(forward.range).toEqual(box(1, 1, 3, 1))
    expect(backward.range).toEqual(forward.range)
    expect(forward).toMatchObject({ linewise: true, startLine: 1, endLine: 2 })
  })

  it('block rows follow the column span, whichever corner is the cursor', () => {
    const lines = toLineReader(['abcdef', 'abcdef', 'abcdef'])
    const forward = visualOperatorRange(lines, selection('visual-block', at(1, 2), at(3, 4)))
    const backward = visualOperatorRange(lines, selection('visual-block', at(3, 4), at(1, 2)))
    expect(forward.blocks).toEqual([box(1, 2, 1, 5), box(2, 2, 2, 5), box(3, 2, 3, 5)])
    expect(backward.blocks).toEqual(forward.blocks)
  })

  it('a block over short rows clips them, and leaves rows ending before the block out', () => {
    const lines = toLineReader(['abcdef', 'ab', '', 'abcdef'])
    const range = visualOperatorRange(lines, selection('visual-block', at(1, 4), at(4, 5)))
    // Row 2 ends before column 4 and row 3 is empty: neither contributes a range.
    expect(range.blocks).toEqual([box(1, 4, 1, 6), box(4, 4, 4, 6)])
    expect(range.startLine).toBe(1)
    expect(range.endLine).toBe(4)
  })

  it('a block row that ends exactly at the block start yields an empty range', () => {
    const lines = toLineReader(['abcdef', 'abc', 'abcdef'])
    const range = visualOperatorRange(lines, selection('visual-block', at(1, 4), at(3, 5)))
    expect(range.blocks).toEqual([box(1, 4, 1, 6), box(2, 4, 2, 4), box(3, 4, 3, 6)])
  })

  it('D / C extend every block row to its line end', () => {
    const lines = toLineReader(['abcdef', 'ab', 'abcd'])
    const range = visualOperatorRange(lines, selection('visual-block', at(1, 2), at(3, 3)), {
      toEol: true,
    })
    expect(range.blocks).toEqual([box(1, 2, 1, 7), box(2, 2, 2, 3), box(3, 2, 3, 5)])
  })

  it('paints one Monaco selection per row, the cursor row first', () => {
    const lines = toLineReader(['abcd', 'abcd', 'abcd'])
    const selections = visualMonacoSelections(lines, selection('visual-block', at(1, 2), at(3, 3)))
    expect(selections).toHaveLength(3)
    expect(selections[0]?.positionLineNumber).toBe(3)
  })
})

describe('blockInsertPositions', () => {
  const lines = toLineReader(['abcdef', 'ab', 'abcdef'])

  it('I skips rows that end before the block, A pads to the block edge or the row end', () => {
    const block = selection('visual-block', at(1, 4), at(3, 5))
    expect(blockInsertPositions(lines, block, 'start')).toEqual([at(1, 4), at(3, 4)])
    expect(blockInsertPositions(lines, block, 'end')).toEqual([at(1, 6), at(2, 3), at(3, 6)])
  })

  it('A after $ appends at the end of every row', () => {
    const block = selection('visual-block', at(1, 2), at(3, 3), true)
    expect(blockInsertPositions(lines, block, 'end')).toEqual([at(1, 7), at(2, 3), at(3, 7)])
  })
})

describe('visualExtent / selectionFromExtent', () => {
  it('round-trips the size of a characterwise, linewise and block selection', () => {
    const lines = toLineReader(['abcdef', 'abcdef', 'abcdef'])
    for (const original of [
      selection('visual', at(1, 2), at(1, 4)),
      selection('visual', at(1, 2), at(2, 3)),
      selection('visual-line', at(1, 1), at(2, 1)),
      selection('visual-block', at(1, 2), at(3, 4)),
    ]) {
      const replay = selectionFromExtent(lines, at(1, 2), visualExtent(original))
      expect(visualExtent(replay)).toEqual(visualExtent(original))
    }
  })

  it('orders a backward selection before measuring it', () => {
    expect(visualExtent(selection('visual', at(1, 4), at(1, 2)))).toEqual({
      mode: 'visual',
      lines: 1,
      columns: 3,
    })
  })
})
