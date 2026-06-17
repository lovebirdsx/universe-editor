import { describe, expect, it } from 'vitest'
import { toggleDelimiter } from '../toggleDelimiter.js'
import { changeHeadingLevel } from '../heading.js'
import { toggleTask } from '../task.js'
import { computeSmartEnter, computeIndent, computeOutdent } from '../smartList.js'
import { renumberOrderedLists } from '../renumber.js'
import { formatTable, formatTables, navigateTable } from '../table.js'
import { splitLines, type EditOp, type EditResult, type Selection } from '../textEditing.js'

function sel(line: number, character: number, endLine = line, endChar = character): Selection {
  return { anchor: { line, character }, active: { line: endLine, character: endChar } }
}

/** Apply an EditResult's edits to `lines` to assert the resulting text. Edits
 *  are applied bottom-up so earlier offsets stay valid. */
function applyEdits(lines: string[], edits: readonly EditOp[]): string[] {
  let text = lines.join('\n')
  const sorted = [...edits].sort((a, b) => {
    if (a.range.start.line !== b.range.start.line) return b.range.start.line - a.range.start.line
    return b.range.start.character - a.range.start.character
  })
  for (const e of sorted) {
    const before = offsetOf(text, e.range.start.line, e.range.start.character)
    const after = offsetOf(text, e.range.end.line, e.range.end.character)
    text = text.slice(0, before) + e.text + text.slice(after)
  }
  return text.split('\n')
}

function offsetOf(text: string, line: number, character: number): number {
  let off = 0
  const lines = text.split('\n')
  for (let i = 0; i < line; i++) off += lines[i]!.length + 1
  return off + character
}

function apply(lines: string[], result: EditResult | undefined): string[] {
  if (!result) return lines
  return applyEdits(lines, result.edits)
}

describe('toggleDelimiter', () => {
  it('wraps a selection in bold', () => {
    const lines = ['hello world']
    const r = toggleDelimiter(lines, [sel(0, 0, 0, 5)], '**')
    expect(apply(lines, r)).toEqual(['**hello** world'])
  })

  it('unwraps when the selection already carries the delimiter', () => {
    const lines = ['**hello** world']
    const r = toggleDelimiter(lines, [sel(0, 0, 0, 9)], '**')
    expect(apply(lines, r)).toEqual(['hello world'])
  })

  it('strips delimiters sitting just outside the selection', () => {
    const lines = ['**hello** world']
    const r = toggleDelimiter(lines, [sel(0, 2, 0, 7)], '**')
    expect(apply(lines, r)).toEqual(['hello world'])
  })

  it('toggles the word under an empty cursor', () => {
    const lines = ['hello world']
    const r = toggleDelimiter(lines, [sel(0, 2)], '*')
    expect(apply(lines, r)).toEqual(['*hello* world'])
  })

  it.each([
    ['bold', '**', '**hello, world**'],
    ['italic', '*', '*hello, world*'],
    ['inline code', '`', '`hello, world`'],
    ['strikethrough', '~~', '~~hello, world~~'],
    ['math', '$', '$hello, world$'],
  ])('unwraps an enclosing %s span under an empty cursor', (_, delim, line) => {
    const lines = [line]
    const r = toggleDelimiter(lines, [sel(0, line.indexOf('world') + 2)], delim)
    expect(apply(lines, r)).toEqual(['hello, world'])
  })

  it('unwraps an enclosing span when the selection is inside it', () => {
    const lines = ['*hello, world*']
    const r = toggleDelimiter(lines, [sel(0, 8, 0, 13)], '*')
    expect(apply(lines, r)).toEqual(['hello, world'])
  })

  it('does not unwrap across separate spans', () => {
    const lines = ['*one* plain *two*']
    const r = toggleDelimiter(lines, [sel(0, 7)], '*')
    expect(apply(lines, r)).toEqual(['*one* *plain* *two*'])
  })

  it('unwraps italic inside a `*` bullet list item without mistaking the bullet', () => {
    const lines = ['* *hello, world*']
    const r = toggleDelimiter(lines, [sel(0, 13)], '*')
    expect(apply(lines, r)).toEqual(['* hello, world'])
  })

  it('wraps a word in a `*` bullet list item without mistaking the bullet', () => {
    const lines = ['* hello world']
    const r = toggleDelimiter(lines, [sel(0, 4)], '*')
    expect(apply(lines, r)).toEqual(['* *hello* world'])
  })

  it('inserts an empty pair when there is no word', () => {
    const lines = ['  ']
    const r = toggleDelimiter(lines, [sel(0, 1)], '`')
    expect(apply(lines, r)).toEqual([' `` '])
  })
})

describe('changeHeadingLevel', () => {
  it('makes a plain line an h1', () => {
    const lines = ['title']
    expect(apply(lines, changeHeadingLevel(lines, [sel(0, 0)], 1))).toEqual(['# title'])
  })

  it('increases an existing heading', () => {
    const lines = ['## title']
    expect(apply(lines, changeHeadingLevel(lines, [sel(0, 0)], 1))).toEqual(['### title'])
  })

  it('strips the heading when decreased below h1', () => {
    const lines = ['# title']
    expect(apply(lines, changeHeadingLevel(lines, [sel(0, 0)], -1))).toEqual(['title'])
  })

  it('caps at h6', () => {
    const lines = ['###### title']
    expect(apply(lines, changeHeadingLevel(lines, [sel(0, 0)], 1))).toEqual(['###### title'])
  })
})

describe('toggleTask', () => {
  it('adds a checkbox to a bullet item', () => {
    const lines = ['- buy milk']
    expect(apply(lines, toggleTask(lines, [sel(0, 0)]))).toEqual(['- [x] buy milk'])
  })

  it('toggles an existing checkbox off', () => {
    const lines = ['- [x] buy milk']
    expect(apply(lines, toggleTask(lines, [sel(0, 0)]))).toEqual(['- [ ] buy milk'])
  })

  it('drives a multi-line block from the first line', () => {
    const lines = ['- [ ] a', '- [x] b']
    const out = apply(lines, toggleTask(lines, [sel(0, 0, 1, 5)]))
    expect(out).toEqual(['- [x] a', '- [x] b'])
  })
})

describe('computeSmartEnter', () => {
  it('continues a bullet list', () => {
    const lines = ['- item']
    const r = computeSmartEnter(lines, [sel(0, 6)])
    expect(r).not.toBe('default')
    expect(apply(lines, r as EditResult)).toEqual(['- item', '- '])
  })

  it('continues and increments an ordered list', () => {
    const lines = ['1. first']
    const r = computeSmartEnter(lines, [sel(0, 8)])
    expect(apply(lines, r as EditResult)).toEqual(['1. first', '2. '])
  })

  it('exits the list on an empty item', () => {
    const lines = ['- first', '- ']
    const r = computeSmartEnter(lines, [sel(1, 2)])
    expect(apply(lines, r as EditResult)).toEqual(['- first', ''])
  })

  it('returns default outside a list', () => {
    expect(computeSmartEnter(['plain text'], [sel(0, 4)])).toBe('default')
  })

  it('continues a task item as unchecked', () => {
    const lines = ['- [x] done']
    const r = computeSmartEnter(lines, [sel(0, 10)])
    expect(apply(lines, r as EditResult)).toEqual(['- [x] done', '- [ ] '])
  })

  it('renumbers following items without duplicating when Enter is pressed mid-list', () => {
    const lines = ['1. hello', '2. world', '2. yes']
    const r = computeSmartEnter(lines, [sel(1, 8)])
    expect(apply(lines, r as EditResult)).toEqual(['1. hello', '2. world', '3. ', '4. yes'])
  })

  it('inserts mid-document without disturbing trailing non-list lines', () => {
    const lines = ['1. a', '3. c', 'tail']
    const r = computeSmartEnter(lines, [sel(0, 4)])
    expect(apply(lines, r as EditResult)).toEqual(['1. a', '2. ', '3. c', 'tail'])
  })

  it('inserts a blank line above when the cursor is at the start of a task line', () => {
    const lines = ['- [ ] a', '- [ ] b']
    const r = computeSmartEnter(lines, [sel(1, 0)])
    expect(apply(lines, r as EditResult)).toEqual(['- [ ] a', '', '- [ ] b'])
  })

  it('inserts a blank line above when the cursor is at the start of a bullet line', () => {
    const lines = ['- item']
    const r = computeSmartEnter(lines, [sel(0, 0)])
    expect(apply(lines, r as EditResult)).toEqual(['', '- item'])
  })

  it('splits an ordered list at a line start, leaving the item as a new run', () => {
    const lines = ['1. a', '2. b']
    const r = computeSmartEnter(lines, [sel(1, 0)])
    expect(apply(lines, r as EditResult)).toEqual(['1. a', '', '2. b'])
  })
})

describe('computeIndent / computeOutdent', () => {
  it('indents a list item by two spaces', () => {
    const lines = ['- item']
    const r = computeIndent(lines, [sel(0, 2)])
    expect(apply(lines, r as EditResult)).toEqual(['  - item'])
  })

  it('outdents an indented item', () => {
    const lines = ['  - item']
    const r = computeOutdent(lines, [sel(0, 4)])
    expect(apply(lines, r as EditResult)).toEqual(['- item'])
  })

  it('returns default when Tab is pressed past the content column', () => {
    expect(computeIndent(['- item'], [sel(0, 6)])).toBe('default')
  })

  it('returns default when outdenting a top-level item', () => {
    expect(computeOutdent(['- item'], [sel(0, 2)])).toBe('default')
  })
})

describe('renumberOrderedLists', () => {
  it('fixes a broken sequence', () => {
    const lines = ['1. a', '1. b', '5. c']
    expect(apply(lines, { edits: renumberOrderedLists(lines) })).toEqual(['1. a', '2. b', '3. c'])
  })

  it('respects the starting number', () => {
    const lines = ['3. a', '3. b']
    expect(apply(lines, { edits: renumberOrderedLists(lines) })).toEqual(['3. a', '4. b'])
  })

  it('restarts after a blank line', () => {
    const lines = ['1. a', '2. b', '', '1. x', '9. y']
    expect(apply(lines, { edits: renumberOrderedLists(lines) })).toEqual([
      '1. a',
      '2. b',
      '',
      '1. x',
      '2. y',
    ])
  })

  it('counts nested levels independently', () => {
    const lines = ['1. a', '   1. nested', '   3. nested', '2. b']
    expect(apply(lines, { edits: renumberOrderedLists(lines) })).toEqual([
      '1. a',
      '   1. nested',
      '   2. nested',
      '2. b',
    ])
  })
})

describe('formatTable', () => {
  it('aligns columns', () => {
    const lines = ['| a | bb |', '| - | - |', '| ccc | d |']
    const out = apply(lines, formatTable(lines, 0))
    expect(out).toEqual(['| a   | bb  |', '| --- | --- |', '| ccc | d   |'])
  })

  it('preserves alignment markers', () => {
    const lines = ['| a | b |', '| :- | -: |', '| 1 | 2 |']
    const out = apply(lines, formatTable(lines, 0))
    expect(out[1]).toBe('| :-- | --: |')
  })

  it('returns undefined outside a table', () => {
    expect(formatTable(['plain'], 0)).toBeUndefined()
  })
})

describe('navigateTable', () => {
  it('moves to the next cell', () => {
    const lines = ['| a | b |', '| - | - |', '| 1 | 2 |']
    const r = navigateTable(lines, [sel(2, 2)], 'next')
    expect(r?.selections?.[0]?.active).toEqual({ line: 2, character: 6 })
  })

  it('appends a row past the last cell', () => {
    const lines = ['| a | b |', '| - | - |', '| 1 | 2 |']
    const r = navigateTable(lines, [sel(2, 6)], 'next')
    expect(apply(lines, r)).toEqual(['| a | b |', '| - | - |', '| 1 | 2 |', '| | |'])
  })

  it('lands on the first cell content (not before the leading pipe) when moving back', () => {
    const lines = ['| foo | bar |', '| --- | --- |', '| 1 | 2 |']
    // Cursor in the second cell of the header; Shift+Tab → first cell content.
    const r = navigateTable(lines, [sel(0, 8)], 'prev')
    // 'foo' starts at offset 2 ("| ").
    expect(r?.selections?.[0]?.active).toEqual({ line: 0, character: 2 })
  })

  it('wraps to the first cell content of the next row', () => {
    const lines = ['| foo | bar |', '| --- | --- |', '| 1 | 2 |']
    // Last cell of the header row; Tab skips the delimiter row to row 3, cell 0.
    const r = navigateTable(lines, [sel(0, 8)], 'next')
    expect(r?.selections?.[0]?.active).toEqual({ line: 2, character: 2 })
  })
})

describe('splitLines (CRLF tolerance)', () => {
  it('splits on CRLF, CR, and LF', () => {
    expect(splitLines('a\r\nb\rc\nd')).toEqual(['a', 'b', 'c', 'd'])
  })

  it('lets list/task parsing work on non-final CRLF lines', () => {
    // The original bug: split('\n') left a trailing \r on every line but the
    // last, so regexes anchored with $ failed except on the final line.
    const lines = splitLines('- a\r\n- b\r\n- c')
    const out = apply(lines, toggleTask(lines, [sel(0, 0)]))
    expect(out[0]).toBe('- [x] a')
  })

  it('keeps heading level changes correct on a non-final CRLF line', () => {
    // Regression: \r made HEADING_RE miss, so increase fell into the "not a
    // heading" branch (## → "# ##\r") and decrease became a no-op.
    const lines = splitLines('## a\r\nbody')
    expect(apply(lines, changeHeadingLevel(lines, [sel(0, 0)], 1))[0]).toBe('### a')
    expect(apply(lines, changeHeadingLevel(lines, [sel(0, 0)], -1))[0]).toBe('# a')
  })
})

describe('formatTables (whole-document / range)', () => {
  it('formats every table in the document', () => {
    const lines = [
      '| a | bb |',
      '| - | - |',
      '| ccc | d |',
      '',
      'text',
      '',
      '| x | y |',
      '| - | - |',
      '| zzzz | w |',
    ]
    const out = apply(lines, formatTables(lines, 0, lines.length - 1))
    expect(out).toEqual([
      '| a   | bb  |',
      '| --- | --- |',
      '| ccc | d   |',
      '',
      'text',
      '',
      '| x    | y   |',
      '| ---- | --- |',
      '| zzzz | w   |',
    ])
  })

  it('returns undefined when the range has no tables', () => {
    expect(formatTables(['plain', 'text'], 0, 1)).toBeUndefined()
  })
})
