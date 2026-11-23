/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Buffer edits for the editor controller: operators, `x`/`s`/`r`/`~`, paste, join,
 *  Visual-mode actions, the Insert-mode entry/exit and its undo grouping. Every text
 *  change goes through `replaceRange` / `insertAt`, which bracket it with undo stops
 *  so one Normal command is one `u` step. An Insert session is the exception: the
 *  change that opened it (`cw`, `s`, `o`) and everything typed afterwards share one
 *  undo group, closed by `exitInsert`.
 *
 *  Registers are explicit: every method that writes one takes the `"x` name the user
 *  selected, and `paste*` receives the content to put (the controller resolves it,
 *  because the system clipboard is asynchronous).
 *--------------------------------------------------------------------------------------------*/

import {
  clampNormalPosition,
  firstNonBlankColumn,
  leadingBlankCount,
  lineLength,
  type VimScreenOps,
} from './vimMotions.js'
import {
  getVimOperator,
  linewiseOperatorRange,
  lowerCase,
  operatorText,
  resolveOperatorRange,
  toggleCase,
  upperCase,
  type VimOperatorHost,
  type VimOperatorRange,
} from './vimOperators.js'
import { setVimRegister, type VimRegisterContent } from './vimRegisters.js'
import { getVimTextObject, type VimTextObjectRange } from './vimTextObjects.js'
import type { VimInsertReplay } from './vimSession.js'
import {
  comparePositions,
  type VimEditor,
  type VimInsertPlacement,
  type VimLineReader,
  type VimMode,
  type VimMotion,
  type VimMotionArgs,
  type VimOperator,
  type VimPosition,
  type VimRange,
  type VimTextModel,
  type VimTextObjectId,
  type VimVisualAction,
} from './vimTypes.js'
import { blockInsertPositions, orderedEnds, visualOperatorRange } from './vimVisual.js'
import type { VimVisualSelection } from './vimVisual.js'

export interface VimEditsOptions {
  readonly editor: VimEditor
  readonly getCursor: () => VimPosition
  /** Move the cursor and scroll it into view when it left the viewport. */
  readonly moveCursor: (position: VimPosition) => void
  readonly setMode: (mode: VimMode) => void
  /** A register was written; `register` is the `"x` the user chose (null = none). Mirrors it to the clipboard. */
  readonly onRegisterWrite?: (content: VimRegisterContent, register: string | null) => void
  /** The outermost closed fold covering a line: line-wise commands take it whole (`dd` on a fold header). */
  readonly closedFoldAt?: (line: number) => { readonly start: number; readonly end: number } | null
  /** Fold-aware row counting, so `3dd` / `dj` count a closed fold as one row. */
  readonly createScreenOps?: (lines: VimLineReader) => VimScreenOps
}

export interface VimVisualActionOptions {
  readonly linewise?: boolean | undefined
  readonly toEol?: boolean | undefined
  readonly char?: string | undefined
  readonly count: number
  readonly register: string | null
  /** What `p` / `P` put, already resolved by the controller. */
  readonly content?: VimRegisterContent | null | undefined
}

/**
 * Every command that can do nothing reports whether it did something: a failed
 * command (`x` on an empty line, `p` of an empty register) must not replace the
 * change `.` repeats.
 */
export interface VimEdits {
  runOperator(
    operator: VimOperator,
    motion: VimMotion,
    count: number,
    register: string | null,
    args?: VimMotionArgs,
  ): boolean
  /** Returns false when the object does not exist at the cursor (the command is a no-op). */
  runOperatorTextObject(
    operator: VimOperator,
    object: VimTextObjectId,
    around: boolean,
    count: number,
    register: string | null,
  ): boolean
  runLinewise(operator: VimOperator, count: number, register: string | null): boolean
  enterInsert(placement: VimInsertPlacement): void
  exitInsert(): void
  /** Insert text at the cursor inside the current Insert session (counted inserts, literal `.` replay). */
  typeText(text: string): void
  /** Replay the keys of an Insert session through Monaco's own editing commands. */
  replayInsert(replay: VimInsertReplay): void
  deleteChars(count: number, backward: boolean, register: string | null): boolean
  substituteChar(count: number, register: string | null): boolean
  paste(content: VimRegisterContent | null, count: number, before: boolean): boolean
  joinLines(count: number, keepSpacing: boolean): boolean
  replaceChar(char: string, count: number): boolean
  toggleCase(count: number): boolean
  undo(): void
  redo(): void
  /** False when nothing happened (a `p` with an empty register). */
  visualAction(
    selection: VimVisualSelection,
    action: VimVisualAction,
    options: VimVisualActionOptions,
  ): boolean
  /** Block `I` / `A`: one cursor per row, then Insert. */
  visualBlockInsert(selection: VimVisualSelection, at: 'start' | 'end'): void
}

function toMonaco(position: VimPosition): { lineNumber: number; column: number } {
  return { lineNumber: position.line, column: position.column }
}

function isEmptyRange(range: VimRange): boolean {
  return range.startLineNumber === range.endLineNumber && range.startColumn === range.endColumn
}

function collapsed(position: VimPosition): VimRange {
  return {
    startLineNumber: position.line,
    startColumn: position.column,
    endLineNumber: position.line,
    endColumn: position.column,
  }
}

function caret(position: VimPosition) {
  return {
    selectionStartLineNumber: position.line,
    selectionStartColumn: position.column,
    positionLineNumber: position.line,
    positionColumn: position.column,
  }
}

/** Column of the last code point of a non-empty single-line text inserted at `column`. */
function lastCharColumn(column: number, text: string): number {
  const end = column + text.length - 1
  const last = text.charCodeAt(text.length - 1)
  const beforeLast = text.charCodeAt(text.length - 2)
  const pair =
    text.length >= 2 &&
    last >= 0xdc00 &&
    last <= 0xdfff &&
    beforeLast >= 0xd800 &&
    beforeLast <= 0xdbff
  return pair ? end - 1 : end
}

/** Where the cursor ends up just past `text` inserted at `start`. */
function positionAfter(start: VimPosition, text: string): VimPosition {
  const parts = text.split('\n')
  if (parts.length === 1) return { line: start.line, column: start.column + text.length }
  return { line: start.line + parts.length - 1, column: (parts[parts.length - 1] ?? '').length + 1 }
}

/** Where the cursor rests after a Visual action: the selection's top-left corner. */
export function visualStartPosition(selection: VimVisualSelection): VimPosition {
  const top = Math.min(selection.anchor.line, selection.cursor.line)
  const [orderedStart] = orderedEnds(selection)
  if (selection.mode === 'visual-block') {
    return { line: top, column: Math.min(selection.anchor.column, selection.cursor.column) }
  }
  return selection.mode === 'visual-line'
    ? { line: top, column: orderedStart.column }
    : orderedStart
}

/** A text-object range as the range an operator acts on. */
export function textObjectOperatorRange(
  model: VimTextModel,
  range: VimTextObjectRange,
): VimOperatorRange {
  if (range.linewise) return linewiseOperatorRange(model, range.start.line, range.end.line)
  return {
    range: {
      startLineNumber: range.start.line,
      startColumn: range.start.column,
      endLineNumber: range.end.line,
      endColumn: range.end.column,
    },
    linewise: false,
    startLine: range.start.line,
    endLine: range.end.line,
  }
}

export function createVimEdits(options: VimEditsOptions): VimEdits {
  const { editor, getCursor, moveCursor, setMode, onRegisterWrite, closedFoldAt, createScreenOps } =
    options

  /**
   * One edit between undo stops. `joinInsert` leaves the trailing stop open so
   * the Insert session that follows (`cw`, `s`) lands in the same undo group.
   */
  function replaceRange(range: VimRange, text: string, joinInsert = false): void {
    editor.pushUndoStop()
    editor.executeEdits('vim', [{ range, text }])
    if (!joinInsert) editor.pushUndoStop()
  }

  function insertAt(position: VimPosition, text: string): void {
    replaceRange(collapsed(position), text)
  }

  function writeRegister(
    content: VimRegisterContent,
    register: string | null,
    origin: 'yank' | 'delete',
  ): void {
    const stored = setVimRegister(content, register, origin)
    if (stored !== null) onRegisterWrite?.(stored, register)
  }

  /** Rewrite each range through `fn` in one undo step. */
  function transformRanges(
    model: VimTextModel,
    ranges: readonly VimRange[],
    fn: (text: string) => string,
    cursorAt: VimPosition | null,
  ): void {
    const changes = ranges
      .map((range) => ({ range, before: model.getValueInRange(range) }))
      .map(({ range, before }) => ({ range, before, text: fn(before) }))
      .filter((change) => change.text !== change.before)
      .map(({ range, text }) => ({ range, text }))
    if (changes.length > 0) {
      editor.pushUndoStop()
      editor.executeEdits('vim', changes)
      editor.pushUndoStop()
    }
    if (cursorAt !== null) editor.setPosition(toMonaco(clampNormalPosition(model, cursorAt)), 'vim')
  }

  function createHost(model: VimTextModel, register: string | null): VimOperatorHost {
    return {
      model,
      yank: (content, origin) => writeRegister(content, register, origin),
      deleteRange(range, { enterInsert }) {
        if (!isEmptyRange(range)) replaceRange(range, '', enterInsert)
        const start = { line: range.startLineNumber, column: range.startColumn }
        // Insert mode may sit just past the last character; Normal mode may not.
        editor.setPosition(toMonaco(enterInsert ? start : clampNormalPosition(model, start)), 'vim')
      },
      deleteBlocks(ranges, { enterInsert }) {
        const nonEmpty = ranges.filter((range) => !isEmptyRange(range))
        if (nonEmpty.length > 0) {
          editor.pushUndoStop()
          editor.executeEdits(
            'vim',
            nonEmpty.map((range) => ({ range, text: '' })),
          )
          if (!enterInsert) editor.pushUndoStop()
        }
        const first = ranges[0]
        if (first === undefined) return
        const start = { line: first.startLineNumber, column: first.startColumn }
        editor.setPosition(toMonaco(enterInsert ? start : clampNormalPosition(model, start)), 'vim')
      },
      transform: (ranges, fn, cursorAt) => transformRanges(model, ranges, fn, cursorAt),
      clearLines(startLine, endLine) {
        const range = {
          startLineNumber: startLine,
          startColumn: 1,
          endLineNumber: endLine,
          endColumn: model.getLineContent(endLine).length + 1,
        }
        if (!isEmptyRange(range)) replaceRange(range, '', true)
        editor.setPosition(toMonaco({ line: startLine, column: 1 }), 'vim')
      },
      shiftLines(startLine, endLine, direction) {
        editor.pushUndoStop()
        editor.setSelections(
          [
            {
              selectionStartLineNumber: startLine,
              selectionStartColumn: 1,
              positionLineNumber: endLine,
              positionColumn: model.getLineContent(endLine).length + 1,
            },
          ],
          'vim',
        )
        editor.trigger(
          'vim',
          direction === 'in' ? 'editor.action.indentLines' : 'editor.action.outdentLines',
          null,
        )
        editor.pushUndoStop()
        // Vim leaves the cursor on the first non-blank of the first shifted line.
        moveCursor({
          line: startLine,
          column: firstNonBlankColumn(model.getLineContent(startLine)),
        })
      },
      enterInsert: () => setMode('insert'),
    }
  }

  /** Line-wise targets cover a closed fold whole, like Vim (`dd` on a fold header deletes the fold). */
  function expandFolds(model: VimTextModel, target: VimOperatorRange): VimOperatorRange {
    if (!target.linewise || target.blocks !== undefined || closedFoldAt === undefined) return target
    const start = closedFoldAt(target.startLine)?.start ?? target.startLine
    const end = closedFoldAt(target.endLine)?.end ?? target.endLine
    if (start === target.startLine && end === target.endLine) return target
    return linewiseOperatorRange(model, start, end)
  }

  /** After a line-wise delete the cursor rests on the first non-blank of the line that took its place. */
  function landAfterLinewiseDelete(model: VimTextModel, target: VimOperatorRange): void {
    if (!target.linewise || target.blocks !== undefined) return
    const line = Math.min(target.startLine, model.getLineCount())
    moveCursor(
      clampNormalPosition(model, {
        line,
        column: firstNonBlankColumn(model.getLineContent(line)),
      }),
    )
  }

  /** A yank leaves the cursor at the start of the yanked text (`yb`, `y0`, `yk`). */
  function landAfterYank(model: VimTextModel, target: VimOperatorRange, origin: VimPosition): void {
    if (target.blocks !== undefined) return
    const at = target.linewise
      ? { line: target.startLine, column: origin.column }
      : { line: target.range.startLineNumber, column: target.range.startColumn }
    const landing = clampNormalPosition(model, at)
    if (comparePositions(landing, origin) !== 0) moveCursor(landing)
  }

  function applyOperator(
    model: VimTextModel,
    operator: VimOperator,
    target: VimOperatorRange | null,
    register: string | null,
  ): boolean {
    if (target === null) return false
    const expanded = expandFolds(model, target)
    const origin = getCursor()
    getVimOperator(operator).apply(createHost(model, register), expanded)
    if (operator === 'y') landAfterYank(model, expanded, origin)
    else if (operator === 'd') landAfterLinewiseDelete(model, expanded)
    return true
  }

  /**
   * `dj` / `dk` count a closed fold as one row; the plain operator resolver counts
   * model lines. `undefined` means the motion is not a vertical one.
   */
  function resolveVerticalRange(
    model: VimTextModel,
    from: VimPosition,
    motion: VimMotion,
    count: number,
  ): VimOperatorRange | null | undefined {
    if ((motion !== 'j' && motion !== 'k') || createScreenOps === undefined) return undefined
    const screen = createScreenOps(model)
    const target = screen.advanceRows(from.line, motion === 'j' ? 1 : -1, Math.max(1, count))
    const origin = closedFoldAt?.(from.line)?.start ?? from.line
    // Like Vim, a vertical motion that cannot move fails the whole operator.
    if (target === origin) return null
    return linewiseOperatorRange(model, from.line, target)
  }

  function runOperator(
    operator: VimOperator,
    motion: VimMotion,
    count: number,
    register: string | null,
    args: VimMotionArgs = {},
  ): boolean {
    const model = editor.getModel()
    if (model === null) return false
    const from = getCursor()
    const vertical = resolveVerticalRange(model, from, motion, count)
    const target =
      vertical !== undefined
        ? vertical
        : resolveOperatorRange(model, from, motion, count, operator, args, createScreenOps?.(model))
    return applyOperator(model, operator, target, register)
  }

  function runOperatorTextObject(
    operator: VimOperator,
    object: VimTextObjectId,
    around: boolean,
    count: number,
    register: string | null,
  ): boolean {
    const model = editor.getModel()
    if (model === null) return false
    const origin = getCursor()
    const range = getVimTextObject(object).resolve({
      lines: model,
      cursor: origin,
      around,
      count,
    })
    if (range === null) return false
    applyOperator(model, operator, textObjectOperatorRange(model, range), register)
    // Yanking an object leaves the cursor at its start, like Vim.
    if (operator === 'y') {
      moveCursor(clampNormalPosition(model, range.linewise ? origin : range.start))
    }
    return true
  }

  function runLinewise(operator: VimOperator, count: number, register: string | null): boolean {
    const model = editor.getModel()
    if (model === null) return false
    const line = getCursor().line
    const rows = Math.max(1, count)
    const first = closedFoldAt?.(line)?.start ?? line
    const last =
      rows > 1 && createScreenOps !== undefined
        ? createScreenOps(model).advanceRows(first, 1, rows - 1)
        : first + rows - 1
    return applyOperator(model, operator, linewiseOperatorRange(model, first, last), register)
  }

  function enterInsert(placement: VimInsertPlacement): void {
    const model = editor.getModel()
    if (model === null) return
    // Whatever came before is its own undo step; the Insert session starts fresh.
    editor.pushUndoStop()
    const from = getCursor()
    const lineEnd = model.getLineContent(from.line).length + 1
    switch (placement) {
      case 'before':
        moveCursor(from)
        break
      case 'after':
        moveCursor({ line: from.line, column: Math.min(lineEnd, from.column + 1) })
        break
      case 'line-start':
        // `I` rests on the first non-blank; a blank-only line ends up at its end.
        moveCursor({
          line: from.line,
          column: leadingBlankCount(model.getLineContent(from.line)) + 1,
        })
        break
      case 'first-column':
        moveCursor({ line: from.line, column: 1 })
        break
      case 'line-end':
        moveCursor({ line: from.line, column: lineEnd })
        break
      case 'new-line-below': {
        // On a closed fold the new line goes below the whole fold.
        const fold = closedFoldAt?.(from.line)
        if (fold) editor.setPosition({ lineNumber: fold.end, column: 1 }, 'vim')
        editor.trigger('vim', 'editor.action.insertLineAfter', null)
        break
      }
      case 'new-line-above': {
        const fold = closedFoldAt?.(from.line)
        if (fold) editor.setPosition({ lineNumber: fold.start, column: 1 }, 'vim')
        editor.trigger('vim', 'editor.action.insertLineBefore', null)
        break
      }
    }
    setMode('insert')
  }

  function exitInsert(): void {
    // Close the session's undo group so `u` reverts the whole Insert at once.
    editor.pushUndoStop()
    const cursor = getCursor()
    // Normal mode rests on a character: step back onto the last typed one. Block
    // insert leaves one cursor per row; Normal mode has exactly one.
    const multi = (editor.getSelections() ?? []).length > 1
    if (cursor.column > 1 || multi) {
      editor.setPosition({ lineNumber: cursor.line, column: Math.max(1, cursor.column - 1) }, 'vim')
    }
  }

  function typeText(text: string): void {
    if (text === '') return
    const at = getCursor()
    editor.executeEdits('vim', [{ range: collapsed(at), text }])
    editor.setPosition(toMonaco(positionAfter(at, text)), 'vim')
  }

  function replayInsert(replay: VimInsertReplay): void {
    if ('literal' in replay) {
      typeText(replay.literal)
      return
    }
    // Source `keyboard` is what makes Monaco apply auto-indent / auto-closing, as
    // the original keystrokes did.
    for (const op of replay.keys) {
      switch (op.kind) {
        case 'type':
          editor.trigger('keyboard', 'type', { text: op.text })
          break
        case 'delete-left':
          editor.trigger('keyboard', 'deleteLeft', null)
          break
        case 'delete-right':
          editor.trigger('keyboard', 'deleteRight', null)
          break
        case 'tab':
          editor.trigger('keyboard', 'tab', null)
          break
      }
    }
  }

  function pasteBlock(
    model: VimTextModel,
    content: VimRegisterContent,
    count: number,
    before: boolean,
  ): boolean {
    const from = getCursor()
    const rows = content.text.split('\n')
    const width = Math.max(...rows.map((row) => row.length))
    const lineCount = model.getLineCount()
    const column = before
      ? from.column
      : Math.min(lineLength(model, from.line) + 1, from.column + 1)
    const edits: { range: VimRange; text: string }[] = []
    let appended = ''
    rows.forEach((row, index) => {
      const line = from.line + index
      const repeated = Array.from({ length: Math.max(1, count) }, () => row.padEnd(width)).join('')
      if (line > lineCount) {
        appended += `\n${' '.repeat(column - 1)}${repeated.trimEnd()}`
        return
      }
      const length = lineLength(model, line)
      const text = length + 1 < column ? `${' '.repeat(column - length - 1)}${row}` : repeated
      // Only pad a row when text follows the insertion point.
      const insertColumn = Math.min(column, length + 1)
      edits.push({
        range: collapsed({ line, column: insertColumn }),
        text: insertColumn > length ? text.trimEnd() : text,
      })
    })
    if (appended !== '') {
      edits.push({
        range: collapsed({ line: lineCount, column: lineLength(model, lineCount) + 1 }),
        text: appended,
      })
    }
    editor.pushUndoStop()
    editor.executeEdits('vim', edits)
    editor.pushUndoStop()
    moveCursor({ line: from.line, column })
    return true
  }

  function paste(content: VimRegisterContent | null, count: number, before: boolean): boolean {
    const model = editor.getModel()
    if (content === null || model === null) return false
    if (content.blockwise === true) return pasteBlock(model, content, count, before)
    const from = getCursor()
    const lineCount = model.getLineCount()
    const repeated = Array.from({ length: Math.max(1, count) }, () => content.text).join('')

    if (content.linewise) {
      const body = repeated.endsWith('\n') ? repeated.slice(0, -1) : repeated
      // A closed fold is one row: `p` goes below all of it, `P` above its header.
      const fold = closedFoldAt?.(from.line)
      const insertLine = before ? (fold?.start ?? from.line) : (fold?.end ?? from.line) + 1
      let landing: number
      if (insertLine > lineCount) {
        // Past the last line there is no break to insert before; add one.
        insertAt(
          { line: lineCount, column: model.getLineContent(lineCount).length + 1 },
          `\n${body}`,
        )
        landing = lineCount + 1
      } else {
        insertAt({ line: insertLine, column: 1 }, `${body}\n`)
        landing = insertLine
      }
      // Vim leaves the cursor on the first non-blank of the first pasted line.
      moveCursor({ line: landing, column: firstNonBlankColumn(body.split('\n')[0] ?? '') })
      return true
    }

    if (repeated.length === 0) return false
    const length = model.getLineContent(from.line).length
    const column = before ? from.column : Math.min(length + 1, from.column + 1)
    insertAt({ line: from.line, column }, repeated)
    // One line: the cursor lands on the last pasted character. Several lines: on
    // the first, like Vim. (The register is `\n`-normalized, so columns are exact
    // even in a CRLF buffer.)
    moveCursor(
      repeated.includes('\n')
        ? { line: from.line, column }
        : { line: from.line, column: lastCharColumn(column, repeated) },
    )
    return true
  }

  /**
   * `J` / `gJ` as one edit batch (one undo step for any count). Vim's spacing: the
   * next line loses its indent and gets one space unless it is empty, starts with
   * `)`, or the text so far is empty / ends in a blank. `joins` past the end of the
   * buffer is clamped, like `5J` near EOF; nothing to join fails.
   */
  function joinAt(line: number, joins: number, keepSpacing: boolean): boolean {
    const model = editor.getModel()
    if (model === null) return false
    const last = Math.min(model.getLineCount(), line + joins)
    if (last <= line) return false
    const edits: { range: VimRange; text: string }[] = []
    let sum = lineLength(model, line)
    let endChar = Array.from(model.getLineContent(line)).pop() ?? ''
    let before = sum
    for (let next = line + 1; next <= last; next++) {
      const text = model.getLineContent(next)
      const prevEnd = lineLength(model, next - 1)
      before = sum
      if (keepSpacing) {
        edits.push({
          range: {
            startLineNumber: next - 1,
            startColumn: prevEnd + 1,
            endLineNumber: next,
            endColumn: 1,
          },
          text: '',
        })
        sum += text.length
        continue
      }
      const indent = leadingBlankCount(text)
      const trimmed = text.slice(indent)
      const glue =
        trimmed !== '' &&
        !trimmed.startsWith(')') &&
        sum !== 0 &&
        endChar !== ' ' &&
        endChar !== '\t'
          ? ' '
          : ''
      edits.push({
        range: {
          startLineNumber: next - 1,
          startColumn: prevEnd + 1,
          endLineNumber: next,
          endColumn: indent + 1,
        },
        text: glue,
      })
      sum += glue.length + trimmed.length
      endChar = Array.from(trimmed).pop() ?? ''
    }
    editor.pushUndoStop()
    editor.executeEdits('vim', edits)
    editor.pushUndoStop()
    // Vim rests on the join point: the inserted space, or the first joined character.
    moveCursor(clampNormalPosition(model, { line, column: before + 1 }))
    return true
  }

  function replaceChar(char: string, count: number): boolean {
    const model = editor.getModel()
    if (model === null) return false
    const from = getCursor()
    const steps = Math.max(1, count)
    const rest = Array.from(model.getLineContent(from.line).slice(from.column - 1))
    // Vim fails the whole command when fewer than `count` characters remain.
    if (rest.length < steps) return false
    const covered = rest.slice(0, steps).join('')
    const range = {
      startLineNumber: from.line,
      startColumn: from.column,
      endLineNumber: from.line,
      endColumn: from.column + covered.length,
    }
    if (char === '\n') {
      replaceRange(range, '\n')
      moveCursor({ line: from.line + 1, column: 1 })
      return true
    }
    replaceRange(range, char.repeat(steps))
    moveCursor({ line: from.line, column: from.column + char.length * (steps - 1) })
    return true
  }

  function toggleCaseAtCursor(count: number): boolean {
    const model = editor.getModel()
    if (model === null) return false
    const from = getCursor()
    const text = model.getLineContent(from.line)
    if (text.length === 0) return false
    const end = Math.min(text.length, from.column - 1 + Math.max(1, count))
    replaceRange(
      {
        startLineNumber: from.line,
        startColumn: from.column,
        endLineNumber: from.line,
        endColumn: end + 1,
      },
      toggleCase(text.slice(from.column - 1, end)),
    )
    moveCursor(clampNormalPosition(model, { line: from.line, column: end + 1 }))
    return true
  }

  /** Replace the selection with register content (`p` / `P` in Visual mode). */
  function visualPaste(
    model: VimTextModel,
    selection: VimVisualSelection,
    target: VimOperatorRange,
    opts: VimVisualActionOptions,
    keepRegister: boolean,
  ): boolean {
    const content = opts.content
    if (content === null || content === undefined) return false
    const deleted = operatorText(model, target)
    const repeated = Array.from({ length: Math.max(1, opts.count) }, () => content.text).join('')
    const body = repeated.endsWith('\n') ? repeated.slice(0, -1) : repeated
    const top = Math.min(selection.anchor.line, selection.cursor.line)
    const bottom = Math.max(selection.anchor.line, selection.cursor.line)

    if (!keepRegister) {
      writeRegister(
        target.blocks !== undefined
          ? { text: deleted, linewise: false, blockwise: true }
          : { text: deleted, linewise: target.linewise },
        null,
        'delete',
      )
    }

    if (selection.mode === 'visual-line') {
      replaceRange(
        {
          startLineNumber: top,
          startColumn: 1,
          endLineNumber: bottom,
          endColumn: lineLength(model, bottom) + 1,
        },
        content.linewise ? body : repeated,
      )
      moveCursor(
        content.linewise
          ? { line: top, column: firstNonBlankColumn(body.split('\n')[0] ?? '') }
          : clampNormalPosition(model, positionAfter({ line: top, column: 1 }, repeated)),
      )
      return true
    }

    if (target.blocks !== undefined) {
      const first = target.blocks[0]
      editor.pushUndoStop()
      editor.executeEdits(
        'vim',
        target.blocks.map((range) => ({ range, text: '' })),
      )
      if (first !== undefined) {
        const at = { line: first.startLineNumber, column: first.startColumn }
        editor.executeEdits('vim', [
          { range: collapsed(at), text: content.linewise ? body : repeated },
        ])
        editor.pushUndoStop()
        moveCursor(at)
      }
      return true
    }

    const start = { line: target.range.startLineNumber, column: target.range.startColumn }
    const text = content.linewise ? `\n${body}\n` : repeated
    replaceRange(target.range, text)
    if (content.linewise) {
      moveCursor({ line: start.line + 1, column: firstNonBlankColumn(body.split('\n')[0] ?? '') })
      return true
    }
    const end = positionAfter(start, text)
    moveCursor(
      text.includes('\n') ? start : { line: end.line, column: Math.max(1, end.column - 1) },
    )
    return true
  }

  function visualAction(
    selection: VimVisualSelection,
    action: VimVisualAction,
    opts: VimVisualActionOptions,
  ): boolean {
    const model = editor.getModel()
    if (model === null) return false
    const host = createHost(model, opts.register)
    const target = visualOperatorRange(model, selection, {
      linewise: opts.linewise === true,
      toEol: opts.toEol === true,
    })
    const top = Math.min(selection.anchor.line, selection.cursor.line)
    const bottom = Math.max(selection.anchor.line, selection.cursor.line)
    const startPos = visualStartPosition(selection)

    switch (action) {
      case 'delete':
        getVimOperator('d').apply(host, target)
        landAfterLinewiseDelete(model, target)
        return true
      case 'yank':
        getVimOperator('y').apply(host, target)
        moveCursor(clampNormalPosition(model, startPos))
        return true
      case 'change':
        getVimOperator('c').apply(host, target)
        if (target.blocks !== undefined) {
          blockCursors(
            target.blocks.map((range) => ({
              line: range.startLineNumber,
              column: range.startColumn,
            })),
          )
        }
        return true
      case 'shift-right':
      case 'shift-left':
        for (let i = 0; i < Math.max(1, opts.count); i++) {
          host.shiftLines(top, bottom, action === 'shift-right' ? 'in' : 'out')
        }
        return true
      case 'toggle-case':
      case 'lower':
      case 'upper':
        host.transform(
          target.blocks ?? [target.range],
          action === 'toggle-case' ? toggleCase : action === 'lower' ? lowerCase : upperCase,
          startPos,
        )
        return true
      case 'replace': {
        const char = opts.char
        if (char === undefined) return false
        host.transform(
          target.blocks ?? [target.range],
          (text) => text.replace(/[^\r\n]/gu, char),
          startPos,
        )
        return true
      }
      case 'join':
      case 'join-nospace':
        return joinAt(top, Math.max(1, bottom - top), action === 'join-nospace')
      case 'paste':
      case 'paste-keep':
        return visualPaste(model, selection, target, opts, action === 'paste-keep')
    }
  }

  /**
   * Monaco restores the selection that was live when an edit ran. Whatever that was
   * (a Visual range, a shifted line block, block-insert cursors), Normal mode must
   * not wake up with it: rest on the start of the restored selection.
   */
  function collapseResidualSelection(): void {
    const model = editor.getModel()
    const selections = editor.getSelections() ?? []
    const first = selections[0]
    if (model === null || first === undefined) return
    if (selections.length === 1 && isEmptyRange(first)) return
    editor.setPosition(
      toMonaco(
        clampNormalPosition(model, { line: first.startLineNumber, column: first.startColumn }),
      ),
      'vim',
    )
  }

  function blockCursors(positions: readonly VimPosition[]): void {
    if (positions.length === 0) return
    editor.setSelections(positions.map(caret), 'vim')
    setMode('insert')
  }

  return {
    runOperator,
    runOperatorTextObject,
    runLinewise,
    enterInsert,
    exitInsert,
    typeText,
    replayInsert,
    // `x` is `dl`, `X` is `dh`, `s` is `cl`: same range rules as any operator.
    deleteChars: (count, backward, register) =>
      runOperator('d', backward ? 'h' : 'l', count, register),
    substituteChar: (count, register) => runOperator('c', 'l', count, register),
    paste,
    joinLines(count, keepSpacing) {
      // `J` joins two lines and every extra count one more, so the number of
      // joins is `count - 1` (a bare `J` still joins once).
      return joinAt(getCursor().line, Math.max(1, count - 1), keepSpacing)
    },
    replaceChar,
    toggleCase: toggleCaseAtCursor,
    undo() {
      editor.trigger('vim', 'undo', null)
      collapseResidualSelection()
    },
    redo() {
      editor.trigger('vim', 'redo', null)
      collapseResidualSelection()
    },
    visualAction,
    visualBlockInsert(selection, at) {
      const model = editor.getModel()
      if (model === null) return
      editor.pushUndoStop()
      blockCursors(blockInsertPositions(model, selection, at))
    },
  }
}
