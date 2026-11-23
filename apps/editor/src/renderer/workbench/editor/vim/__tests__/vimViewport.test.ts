/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Display-row geometry for `gj` / `gk`: Monaco's `getTopForPosition` is the only
 *  public source of soft-wrap boundaries, so a small fake reproduces its layout.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest'
import { toLineReader } from '../vimMotions.js'
import type { VimEditor, VimPosition } from '../vimTypes.js'
import { createVimViewport } from '../vimViewport.js'

const LINE_HEIGHT = 20

interface FakeFoldRegion {
  readonly startLineNumber: number
  readonly endLineNumber: number
  readonly isCollapsed: boolean
}

interface FakeOptions {
  /** Monaco reports -1 when wordWrap is off. */
  readonly wrappingColumn?: number
  readonly folds?: readonly FakeFoldRegion[]
  readonly geometry?: boolean
}

function setup(lines: string[], options: FakeOptions = {}) {
  const wrappingColumn = options.wrappingColumn ?? 5
  const folds = options.folds ?? []
  const wraps = wrappingColumn > 0
  const geometry = options.geometry ?? true

  const hiddenStart = (line: number): number | null => {
    const fold = folds.find(
      (region) =>
        region.isCollapsed && region.startLineNumber < line && line <= region.endLineNumber,
    )
    return fold?.startLineNumber ?? null
  }
  const contentLength = (line: number): number => (lines[line - 1] ?? '').length
  const rowsOf = (line: number): number => {
    if (hiddenStart(line) !== null) return 0
    return wraps ? Math.max(1, Math.ceil(contentLength(line) / wrappingColumn)) : 1
  }
  const firstRowTop = (line: number): number => {
    let rows = 0
    for (let before = 1; before < line; before++) rows += rowsOf(before)
    return rows * LINE_HEIGHT
  }
  const getTopForPosition = (lineNumber: number, column: number): number => {
    if (!geometry || lines.length === 0) return -1
    const clampedLine = Math.max(1, Math.min(lines.length, lineNumber))
    const visibleLine = hiddenStart(clampedLine) ?? clampedLine
    const maxColumn = Math.max(1, contentLength(visibleLine))
    const clampedColumn = Math.max(1, Math.min(maxColumn, column))
    const rows = wraps ? Math.max(1, Math.ceil(maxColumn / wrappingColumn)) : 1
    const row = wraps ? Math.min(rows - 1, Math.floor((clampedColumn - 1) / wrappingColumn)) : 0
    return firstRowTop(visibleLine) + row * LINE_HEIGHT
  }

  const editor = {
    getModel: () => null,
    getTopForLineNumber: (line: number) => firstRowTop(line),
    getBottomForLineNumber: (line: number) => firstRowTop(line) + rowsOf(line) * LINE_HEIGHT,
    getTopForPosition,
    getLayoutInfo: () => ({ height: 400, wrappingColumn }),
    getContribution: (id: string) =>
      id === 'editor.contrib.folding' && folds.length > 0
        ? {
            foldingModel: {
              getAllRegionsAtLine: (line: number) =>
                folds.filter(
                  (region) => region.startLineNumber <= line && line <= region.endLineNumber,
                ),
            },
          }
        : null,
    getVisibleRanges: () => [
      { startLineNumber: 1, startColumn: 1, endLineNumber: lines.length, endColumn: 1 },
    ],
  } as unknown as VimEditor

  const viewport = createVimViewport({
    editor,
    getLineHeight: () => LINE_HEIGHT,
    getCursor: () => ({ line: 1, column: 1 }),
  })
  return { viewport, screen: viewport.createScreenOps(toLineReader(lines)) }
}

function advance(
  screen: ReturnType<typeof setup>['screen'],
  from: VimPosition,
  delta: 1 | -1,
  steps: number,
  preferred?: number,
) {
  return screen.advanceDisplayRows!(from, delta, steps, preferred)
}

describe('display row geometry', () => {
  it('reports whether soft wrapping is on', () => {
    expect(setup(['abc'], { wrappingColumn: 10 }).screen.wrapsLines?.()).toBe(true)
    expect(setup(['abc'], { wrappingColumn: -1 }).screen.wrapsLines?.()).toBe(false)
  })

  it('finds the display offset inside a wrapped line', () => {
    const { screen } = setup(['abcdefghijklm', ''])
    expect(screen.displayOffsetAt!({ line: 1, column: 1 })).toBe(0)
    expect(screen.displayOffsetAt!({ line: 1, column: 5 })).toBe(4)
    // Column 6 starts the second display row.
    expect(screen.displayOffsetAt!({ line: 1, column: 6 })).toBe(0)
    expect(screen.displayOffsetAt!({ line: 1, column: 13 })).toBe(2)
    expect(screen.displayOffsetAt!({ line: 2, column: 1 })).toBe(0)
  })

  it('treats empty, one-character and exactly-divisible lines as single rows', () => {
    const { screen } = setup(['', 'a', 'abcde', 'abcdef'], { wrappingColumn: 5 })
    expect(screen.displayOffsetAt!({ line: 1, column: 1 })).toBe(0)
    expect(screen.displayOffsetAt!({ line: 2, column: 1 })).toBe(0)
    // An exact multiple has no empty trailing display row; its EOL is the last char.
    expect(screen.displayOffsetAt!({ line: 3, column: 5 })).toBe(4)
    // A column on a wrap boundary belongs to the next row at offset 0.
    expect(screen.displayOffsetAt!({ line: 4, column: 6 })).toBe(0)
    expect(advance(screen, { line: 1, column: 1 }, 1, 1)).toEqual({
      position: { line: 2, column: 1 },
      moved: true,
    })
    expect(advance(screen, { line: 2, column: 1 }, 1, 1)).toEqual({
      position: { line: 3, column: 1 },
      moved: true,
    })
    expect(advance(screen, { line: 3, column: 5 }, 1, 1)).toEqual({
      position: { line: 4, column: 1 },
      moved: true,
    })
  })

  it('moves between display rows of one model line and keeps the offset', () => {
    const { screen } = setup(['abcdefghijklm', 'xyz'])
    expect(advance(screen, { line: 1, column: 2 }, 1, 1, 1)).toEqual({
      position: { line: 1, column: 7 },
      moved: true,
    })
    expect(advance(screen, { line: 1, column: 7 }, -1, 1, 1)).toEqual({
      position: { line: 1, column: 2 },
      moved: true,
    })
    expect(advance(screen, { line: 1, column: 7 }, 1, 1, 1)).toEqual({
      position: { line: 1, column: 12 },
      moved: true,
    })
    expect(advance(screen, { line: 1, column: 2 }, 1, 2, 1)).toEqual({
      position: { line: 1, column: 12 },
      moved: true,
    })
  })

  it('crosses model lines in both directions', () => {
    const { screen } = setup(['abcdefghijklm', 'abcdefghij'])
    expect(advance(screen, { line: 1, column: 12 }, 1, 1, 1)).toEqual({
      position: { line: 2, column: 2 },
      moved: true,
    })
    expect(advance(screen, { line: 2, column: 2 }, -1, 1, 1)).toEqual({
      position: { line: 1, column: 12 },
      moved: true,
    })
  })

  it('clamps to the last display row and reports whether anything moved', () => {
    const { screen } = setup(['abcdefghijklm'])
    expect(advance(screen, { line: 1, column: 12 }, 1, 1)).toEqual({
      position: { line: 1, column: 12 },
      moved: false,
    })
    expect(advance(screen, { line: 1, column: 2 }, 1, 9, 1)).toEqual({
      position: { line: 1, column: 12 },
      moved: true,
    })
  })

  it('lands on the last character when the remembered column is Vim’s MAXCOL', () => {
    const { screen } = setup(['abcdefghijklm'])
    expect(advance(screen, { line: 1, column: 2 }, 1, 2, Number.MAX_SAFE_INTEGER)).toEqual({
      position: { line: 1, column: 13 },
      moved: true,
    })
  })

  it('clamps into a short line but lets the caller keep the remembered offset', () => {
    const { screen } = setup(['abcdefghijklm', 'abc', 'abcdefghijklm'], {
      wrappingColumn: 10,
    })
    expect(advance(screen, { line: 1, column: 12 }, 1, 1, 8)).toEqual({
      position: { line: 2, column: 3 },
      moved: true,
    })
    expect(advance(screen, { line: 2, column: 3 }, 1, 1, 8)).toEqual({
      position: { line: 3, column: 9 },
      moved: true,
    })
  })

  it('returns null when Monaco has no layout geometry', () => {
    const { screen } = setup(['abcdefghijklm'], { geometry: false })
    expect(screen.displayOffsetAt!({ line: 1, column: 2 })).toBeNull()
    expect(advance(screen, { line: 1, column: 2 }, 1, 1)).toBeNull()
  })
})

describe('display row geometry with closed folds', () => {
  const longHeader = 'abcdefghijklm'
  const folds: readonly FakeFoldRegion[] = [
    { startLineNumber: 1, endLineNumber: 4, isCollapsed: true },
  ]

  it('counts a wrapping fold header as one row and jumps past the fold', () => {
    const { screen } = setup([longHeader, 'b', 'c', 'd', 'tail'], { folds })
    expect(advance(screen, { line: 1, column: 2 }, 1, 1, 1)).toEqual({
      position: { line: 5, column: 2 },
      moved: true,
    })
  })

  it('enters a closed fold header as a single whole-line row from below', () => {
    const { screen } = setup([longHeader, 'b', 'c', 'd', 'tail'], { folds })
    expect(advance(screen, { line: 5, column: 2 }, -1, 1, 1)).toEqual({
      position: { line: 1, column: 2 },
      moved: true,
    })
  })

  it('normalizes a cursor hidden inside the fold to its header', () => {
    const { screen } = setup([longHeader, 'b', 'ccccc', 'd', 'tail'], { folds })
    expect(screen.displayOffsetAt!({ line: 3, column: 2 })).toBe(1)
    expect(advance(screen, { line: 3, column: 2 }, 1, 1, 1)).toEqual({
      position: { line: 5, column: 2 },
      moved: true,
    })
  })

  it('cannot move down when the fold reaches EOF', () => {
    const { screen } = setup([longHeader, 'b', 'c', 'd'], { folds })
    expect(advance(screen, { line: 1, column: 2 }, 1, 1)).toEqual({
      position: { line: 1, column: 2 },
      moved: false,
    })
  })

  it('treats nested folds as one outer row', () => {
    const nested: readonly FakeFoldRegion[] = [
      { startLineNumber: 2, endLineNumber: 3, isCollapsed: true },
      { startLineNumber: 1, endLineNumber: 4, isCollapsed: true },
    ]
    const { screen } = setup([longHeader, 'b', 'c', 'd', 'tail'], { folds: nested })
    expect(advance(screen, { line: 1, column: 2 }, 1, 1, 1)).toEqual({
      position: { line: 5, column: 2 },
      moved: true,
    })
  })
})
