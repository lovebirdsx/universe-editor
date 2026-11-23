/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Operators and operator ranges. The range an operator acts on is derived from
 *  the motion's `kind` (vimMotions.ts): linewise motions take whole lines,
 *  inclusive ones include the destination character, exclusive ones stop before
 *  it. Whole-line ranges include the trailing line break except at EOF, where the
 *  leading break is removed instead so a `dd` on the last line really deletes the
 *  line rather than leaving a blank one.
 *
 *  Adding an operator: one entry in `VIM_OPERATORS` (its `key` is what starts it
 *  and, doubled, makes it linewise) and the id in `VimOperator`. `apply` only
 *  talks to a `VimOperatorHost`, so it is testable without Monaco. An operator
 *  whose `prefix` is `g` (`g~`, `gu`, `gU`) is reached through the `g` prefix table.
 *--------------------------------------------------------------------------------------------*/

import type { VimRegisterContent, VimRegisterOrigin } from './vimRegisters.js'
import {
  createPlainScreenOps,
  getVimMotion,
  leadingBlankCount,
  lineCountOf,
  lineLength,
  toLineReader,
  type VimLines,
  type VimOperatorTarget,
  type VimScreenOps,
} from './vimMotions.js'
import {
  comparePositions,
  type VimMotion,
  type VimMotionArgs,
  type VimOperator,
  type VimPosition,
  type VimRange,
  type VimTextModel,
} from './vimTypes.js'

export interface VimOperatorRange {
  readonly range: VimRange
  readonly linewise: boolean
  /** First and last (clamped) line the range touches; what `>` / `<` and `cc` act on. */
  readonly startLine: number
  readonly endLine: number
  /** Visual-block: one range per row; `range` then spans the whole block. */
  readonly blocks?: readonly VimRange[]
}

function linewiseRange(lines: VimLines, startLine: number, endLine: number): VimRange {
  const lineCount = lineCountOf(lines)
  const start = Math.max(1, Math.min(lineCount, startLine))
  const end = Math.max(start, Math.min(lineCount, endLine))
  // Deleting through EOF has no trailing break to consume; remove the leading
  // one instead so the line itself is what disappears.
  if (end < lineCount) {
    return { startLineNumber: start, startColumn: 1, endLineNumber: end + 1, endColumn: 1 }
  }
  const endColumn = lineLength(lines, end) + 1
  if (start > 1) {
    const previousLength = lineLength(lines, start - 1)
    return {
      startLineNumber: start - 1,
      startColumn: previousLength + 1,
      endLineNumber: end,
      endColumn,
    }
  }
  return { startLineNumber: start, startColumn: 1, endLineNumber: end, endColumn }
}

/** `count` whole lines from `startLine` (clamped to the buffer): the range of `dd` / `3>>`. */
export function linewiseOperatorRange(
  lines: VimLines,
  startLine: number,
  endLine: number,
): VimOperatorRange {
  const lineCount = lineCountOf(lines)
  const start = Math.max(1, Math.min(lineCount, Math.min(startLine, endLine)))
  const end = Math.max(start, Math.min(lineCount, Math.max(startLine, endLine)))
  return {
    range: linewiseRange(lines, start, end),
    linewise: true,
    startLine: start,
    endLine: end,
  }
}

/** Turn "cursor + destination + kind" into the range an operator acts on. */
export function buildOperatorRange(
  lines: VimLines,
  from: VimPosition,
  target: VimOperatorTarget,
): VimOperatorRange {
  const { to, kind } = target
  if (kind === 'linewise') return linewiseOperatorRange(lines, from.line, to.line)

  const [start, end] = comparePositions(from, to) <= 0 ? [from, to] : [to, from]
  if (kind === 'exclusive' && end.column === 1 && end.line > start.line) {
    // Vim's "o_v" rule: an exclusive motion ending in column 1 stops at the end
    // of the previous line, and becomes linewise when it started in the indent.
    const previousLine = end.line - 1
    const startText = toLineReader(lines).getLineContent(start.line)
    if (start.column <= leadingBlankCount(startText) + 1) {
      return linewiseOperatorRange(lines, start.line, previousLine)
    }
    return {
      range: {
        startLineNumber: start.line,
        startColumn: start.column,
        endLineNumber: previousLine,
        endColumn: lineLength(lines, previousLine) + 1,
      },
      linewise: false,
      startLine: start.line,
      endLine: previousLine,
    }
  }
  const endColumn =
    kind === 'inclusive'
      ? Math.min(lineLength(lines, end.line) + 1, Math.max(1, end.column + 1))
      : Math.max(1, end.column)
  return {
    range: {
      startLineNumber: start.line,
      startColumn: start.column,
      endLineNumber: end.line,
      endColumn,
    },
    linewise: false,
    startLine: start.line,
    endLine: end.line,
  }
}

/**
 * Build the range an operator acts on. Returns `null` when the motion fails or
 * is not available to operators (paging has no viewport here).
 */
export function resolveOperatorRange(
  lines: VimLines,
  from: VimPosition,
  motion: VimMotion,
  count: number,
  operator: VimOperator = 'd',
  args: VimMotionArgs = {},
  screen?: VimScreenOps,
): VimOperatorRange | null {
  const reader = toLineReader(lines)
  const ctx = {
    lines: reader,
    from,
    screen: screen ?? createPlainScreenOps(reader),
    ...args,
  }
  const def = getVimMotion(motion)
  let target: VimOperatorTarget | null
  if (def.resolveForOperator !== undefined) {
    target = def.resolveForOperator(ctx, count, operator)
  } else {
    const to = def.resolve(ctx, count)
    target = to === null ? null : { to, kind: def.kind }
  }
  return target === null ? null : buildOperatorRange(reader, from, target)
}

/** The effects an operator can have; implemented over Monaco by vimEdits.ts. */
export interface VimOperatorHost {
  readonly model: VimTextModel
  /** Write a register (the one `"x` selected, else the unnamed one). */
  yank(content: VimRegisterContent, origin: VimRegisterOrigin): void
  /** Remove every row of a Visual-block selection in one edit. */
  deleteBlocks(ranges: readonly VimRange[], options: { readonly enterInsert: boolean }): void
  /** Rewrite the text of each range through `transform`; `cursorAt` is where the cursor ends up (null = unchanged). */
  transform(
    ranges: readonly VimRange[],
    transform: (text: string) => string,
    cursorAt: VimPosition | null,
  ): void
  /** Remove a range. `enterInsert` keeps the cursor at the range start (no Normal-mode clamp) and joins the change with the Insert session's undo group. */
  deleteRange(range: VimRange, options: { readonly enterInsert: boolean }): void
  /** Empty the lines but keep one blank line (`cc`, `cj`). Joins the Insert session's undo group. */
  clearLines(startLine: number, endLine: number): void
  shiftLines(startLine: number, endLine: number, direction: 'in' | 'out'): void
  enterInsert(): void
}

export interface VimOperatorDef {
  readonly id: VimOperator
  /** Starts the operator; pressing it again makes the operation linewise (`dd`, `>>`). */
  readonly key: string
  /** Set when `key` is the second key of a prefix (`g~`): the operator lives in that prefix table. */
  readonly prefix?: 'g'
  /** One-line help text (English; localized by `vimKeyHelp.ts`). */
  readonly description: string
  apply(host: VimOperatorHost, target: VimOperatorRange): void
}

/** The text an operator removes/copies: whole lines for linewise ranges, the raw range otherwise. */
export function operatorText(model: VimTextModel, target: VimOperatorRange): string {
  if (target.blocks !== undefined) {
    return target.blocks.map((range) => model.getValueInRange(range)).join('\n')
  }
  if (!target.linewise) return model.getValueInRange(target.range)
  const lines: string[] = []
  for (let line = target.startLine; line <= target.endLine; line++) {
    lines.push(model.getLineContent(line))
  }
  return `${lines.join('\n')}\n`
}

function yankTarget(
  host: VimOperatorHost,
  target: VimOperatorRange,
  origin: VimRegisterOrigin,
): void {
  // An empty charwise range must not clobber the register (`d0` in column 1).
  const text = operatorText(host.model, target)
  if (text === '' && !target.linewise) return
  host.yank(
    target.blocks !== undefined
      ? { text, linewise: false, blockwise: true }
      : { text, linewise: target.linewise },
    origin,
  )
}

/** Swap letter case per character; characters whose case mapping changes the length stay as they are. */
export function toggleCase(text: string): string {
  let out = ''
  for (const ch of text) {
    const lower = ch.toLowerCase()
    const swapped = ch === lower ? ch.toUpperCase() : lower
    out += swapped.length === ch.length ? swapped : ch
  }
  return out
}

function mapCase(mapper: (text: string) => string): (text: string) => string {
  return (text) => {
    let out = ''
    for (const ch of text) {
      const mapped = mapper(ch)
      out += mapped.length === ch.length ? mapped : ch
    }
    return out
  }
}

export const lowerCase = mapCase((text) => text.toLowerCase())
export const upperCase = mapCase((text) => text.toUpperCase())

function caseOperator(
  id: 'g~' | 'gu' | 'gU',
  key: string,
  description: string,
  transform: (text: string) => string,
): VimOperatorDef {
  return {
    id,
    key,
    prefix: 'g',
    description,
    apply: (host, target) =>
      host.transform(
        target.blocks ?? [target.range],
        transform,
        // Whole-line case changes leave the cursor alone, like Vim.
        target.linewise
          ? null
          : { line: target.range.startLineNumber, column: target.range.startColumn },
      ),
  }
}

export const VIM_OPERATORS: readonly VimOperatorDef[] = [
  {
    id: 'd',
    key: 'd',
    description: 'Delete',
    apply(host, target) {
      // Vim's delete also yanks, so `dd` then `p` is the everyday move-line idiom.
      yankTarget(host, target, 'delete')
      if (target.blocks !== undefined) host.deleteBlocks(target.blocks, { enterInsert: false })
      else host.deleteRange(target.range, { enterInsert: false })
    },
  },
  {
    id: 'y',
    key: 'y',
    description: 'Yank (copy)',
    apply: (host, target) => yankTarget(host, target, 'yank'),
  },
  {
    id: 'c',
    key: 'c',
    description: 'Change (delete and enter Insert)',
    apply(host, target) {
      yankTarget(host, target, 'delete')
      if (target.blocks !== undefined) {
        host.deleteBlocks(target.blocks, { enterInsert: true })
        return
      }
      if (target.linewise) host.clearLines(target.startLine, target.endLine)
      else host.deleteRange(target.range, { enterInsert: true })
      host.enterInsert()
    },
  },
  {
    id: '>',
    key: '>',
    description: 'Indent',
    apply: (host, target) => host.shiftLines(target.startLine, target.endLine, 'in'),
  },
  {
    id: '<',
    key: '<',
    description: 'Outdent',
    apply: (host, target) => host.shiftLines(target.startLine, target.endLine, 'out'),
  },
  caseOperator('g~', '~', 'Toggle case', toggleCase),
  caseOperator('gu', 'u', 'Lowercase', lowerCase),
  caseOperator('gU', 'U', 'Uppercase', upperCase),
]

const OPERATORS_BY_ID = new Map<VimOperator, VimOperatorDef>(
  VIM_OPERATORS.map((def) => [def.id, def]),
)
const OPERATORS_BY_KEY = new Map<string, VimOperatorDef>(
  VIM_OPERATORS.filter((def) => def.prefix === undefined).map((def) => [def.key, def]),
)

export function getVimOperator(id: VimOperator): VimOperatorDef {
  const def = OPERATORS_BY_ID.get(id)
  if (def === undefined) throw new Error(`[vim] operator "${id}" is not registered`)
  return def
}

/** The operator a bare Normal-mode key starts (`d`, `>`); prefixed ones (`g~`) are not found here. */
export function findVimOperatorByKey(key: string): VimOperatorDef | undefined {
  return OPERATORS_BY_KEY.get(key)
}

/** Operators reached through a prefix key, in registry order. */
export function prefixedVimOperators(prefix: 'g'): readonly VimOperatorDef[] {
  return VIM_OPERATORS.filter((def) => def.prefix === prefix)
}
