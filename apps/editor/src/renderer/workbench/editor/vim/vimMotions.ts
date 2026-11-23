/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Vim motions as a declarative registry. Each `VimMotionDef` states its key(s),
 *  its `kind` (how an operator derives a range from it) and a `resolve` that maps
 *  a cursor to a destination. Adding a motion means adding one entry to
 *  `VIM_MOTIONS` (plus the id to `VimMotion` and, for a new key, nothing else —
 *  the reducer looks keys up here) and a test.
 *
 *  Motions read the buffer through a lazy `VimLineReader`, never a full line
 *  array. Normal-mode columns are 1-based and stop on the last *character* of a
 *  line (`$` is the last character, not the insert position after it). Word
 *  classes follow Vim's `iskeyword` default plus any letter/number — CJK text
 *  therefore forms words instead of one-character hops.
 *--------------------------------------------------------------------------------------------*/

import {
  charClassAt,
  classifyChar,
  wordBackward,
  wordEnd,
  wordForward,
  type VimCharClass,
  type VimWordPos,
} from './vimWordMotions.js'
import type {
  VimFindMotion,
  VimFindState,
  VimLineReader,
  VimMotion,
  VimMotionKind,
  VimOperator,
  VimPosition,
} from './vimTypes.js'

export { classifyChar }
export type { VimCharClass }

/** Either a lazy reader (the Monaco model) or a plain line array (tests, pure callers). */
export type VimLines = VimLineReader | readonly string[]

export function toLineReader(lines: VimLines): VimLineReader {
  if (!Array.isArray(lines)) return lines as VimLineReader
  const array = lines as readonly string[]
  return {
    getLineCount: () => array.length,
    getLineContent: (lineNumber) => array[lineNumber - 1] ?? '',
  }
}

export function lineCountOf(lines: VimLines): number {
  return Array.isArray(lines)
    ? (lines as readonly string[]).length
    : (lines as VimLineReader).getLineCount()
}

export function lineLength(lines: VimLines, line: number): number {
  if (line < 1 || line > lineCountOf(lines)) return 0
  return toLineReader(lines).getLineContent(line).length
}

export function firstNonBlankColumn(text: string): number {
  for (let i = 0; i < text.length; i++) {
    if (!/\s/.test(text[i]!)) return i + 1
  }
  return 1
}

/** Number of leading blank characters (a blank-only line is all indent). */
export function leadingBlankCount(text: string): number {
  let i = 0
  while (i < text.length && /\s/.test(text[i]!)) i++
  return i
}

/** Clamp a normal-mode position onto a real character (empty lines sit at column 1). */
export function clampNormalPosition(lines: VimLines, position: VimPosition): VimPosition {
  const lineCount = lineCountOf(lines)
  if (lineCount === 0) return { line: 1, column: 1 }
  const line = Math.max(1, Math.min(lineCount, position.line))
  const len = lineLength(lines, line)
  const column = len === 0 ? 1 : Math.max(1, Math.min(len, position.column))
  return { line, column }
}

/** One `gj` / `gk` step result: `moved: false` means the buffer edge was already reached. */
export interface VimDisplayMove {
  readonly position: VimPosition
  readonly moved: boolean
}

/**
 * Screen-row awareness injected by the host. Folds and the viewport live in the
 * editor, not in the text, so row-counted motions (`j`, `k`, `<CR>`, paging) ask
 * the host instead of doing line arithmetic.
 */
export interface VimScreenOps {
  /** Move `steps` screen rows from `line`; a closed fold counts as one row. */
  advanceRows(line: number, delta: 1 | -1, steps: number): number
  /** Rows in the viewport; absent when there is no viewport, which disables paging. */
  pageRows?(): number
  /** Whether soft wrapping is actually on; absent means off. */
  wrapsLines?(): boolean
  /** Cursor's character offset inside its display row; null when the geometry is unavailable. */
  displayOffsetAt?(position: VimPosition): number | null
  /** Move `steps` display rows; null means the geometry is unavailable, not "did not move". */
  advanceDisplayRows?(
    from: VimPosition,
    delta: 1 | -1,
    steps: number,
    preferredOffset?: number,
  ): VimDisplayMove | null
}

export function createPlainScreenOps(lines: VimLineReader): VimScreenOps {
  return {
    advanceRows: (line, delta, steps) =>
      Math.max(1, Math.min(lines.getLineCount(), line + delta * steps)),
    wrapsLines: () => false,
  }
}

export interface VimMotionContext {
  readonly lines: VimLineReader
  /** Cursor position, 1-based, already clamped onto a character. */
  readonly from: VimPosition
  readonly screen: VimScreenOps
  /** The character typed after `f`/`F`/`t`/`T`. */
  readonly char?: string
  /** What `;` / `,` repeat. */
  readonly lastFind?: VimFindState | null
  /** `gj`/`gk`'s remembered screen column; absent means derive it from `from`. */
  readonly displayOffset?: number
}

/** What an operator needs from a motion: where it ends and how that end is interpreted. */
export interface VimOperatorTarget {
  readonly to: VimPosition
  readonly kind: VimMotionKind
}

export interface VimMotionDef {
  readonly id: VimMotion
  /** Bare Normal-mode keys that trigger it. Motions reached through a prefix, a Ctrl chord or a navigation key list none. */
  readonly keys: readonly string[]
  readonly kind: VimMotionKind
  /** One-line help text (English; localized by `vimKeyHelp.ts`). */
  readonly description: string
  /** Help-panel spelling when `keys` is empty or not how the user types it (`Ctrl+F`, `gg`). */
  readonly helpKeys?: string
  /** The motion waits for one more typed character (`fx`); the reducer opens a `find` prefix. */
  readonly needsChar?: boolean
  /**
   * Counts screen rows via `ctx.screen` (folds, viewport), so the controller must
   * not snap the result out of closed folds a second time.
   */
  readonly screenAware?: boolean
  /** `count` is the raw typed count, 0 meaning "none" (`gg` / `G` read it as a line number). Null = the motion fails. */
  resolve(ctx: VimMotionContext, count: number): VimPosition | null
  /**
   * Operator-pending destination when it differs from the cursor motion: `dw`
   * stops at the end of the line, `cw` behaves like `ce`, `dl` may reach past the
   * last character, `d}` follows the exclusive-to-linewise rule (see `paragraphTarget`).
   */
  resolveForOperator?(
    ctx: VimMotionContext,
    count: number,
    operator: VimOperator,
  ): VimOperatorTarget | null
}

function steps(count: number): number {
  return Math.max(1, count)
}

function toWordPos(position: VimPosition): VimWordPos {
  return { line: position.line, col: position.column - 1 }
}

/** Raw word-walk result (end-of-line slot allowed) as an exclusive 1-based endpoint. */
function toRawPosition(pos: VimWordPos): VimPosition {
  return { line: pos.line, column: pos.col + 1 }
}

function isNonBlankAt(lines: VimLineReader, position: VimPosition, bigWord: boolean): boolean {
  return charClassAt(lines.getLineContent(position.line), position.column - 1, bigWord) !== 'blank'
}

function wordForwardMotion(id: 'w' | 'W'): VimMotionDef {
  const bigWord = id === 'W'
  return {
    id,
    keys: [id],
    kind: 'exclusive',
    description: bigWord ? 'Next WORD (whitespace-separated)' : 'Next word',
    resolve: (ctx, count) =>
      clampNormalPosition(
        ctx.lines,
        toRawPosition(wordForward(ctx.lines, toWordPos(ctx.from), steps(count), bigWord, false)),
      ),
    resolveForOperator: (ctx, count, operator) => {
      // Vim special case: `cw` on a non-blank is `ce` — it changes the rest of the
      // word and leaves the whitespace after it alone.
      if (operator === 'c' && isNonBlankAt(ctx.lines, ctx.from, bigWord)) {
        const end = wordEnd(ctx.lines, toWordPos(ctx.from), steps(count), bigWord, true)
        return {
          to: clampNormalPosition(ctx.lines, toRawPosition(end)),
          kind: 'inclusive',
        }
      }
      const end = wordForward(ctx.lines, toWordPos(ctx.from), steps(count), bigWord, true)
      return { to: toRawPosition(end), kind: 'exclusive' }
    },
  }
}

function wordBackwardMotion(id: 'b' | 'B'): VimMotionDef {
  const bigWord = id === 'B'
  return {
    id,
    keys: [id],
    kind: 'exclusive',
    description: bigWord ? 'Previous WORD' : 'Previous word',
    resolve: (ctx, count) =>
      clampNormalPosition(
        ctx.lines,
        toRawPosition(wordBackward(ctx.lines, toWordPos(ctx.from), steps(count), bigWord)),
      ),
  }
}

function wordEndMotion(id: 'e' | 'E'): VimMotionDef {
  const bigWord = id === 'E'
  return {
    id,
    keys: [id],
    kind: 'inclusive',
    description: bigWord ? 'End of WORD' : 'End of word',
    resolve: (ctx, count) =>
      clampNormalPosition(
        ctx.lines,
        toRawPosition(wordEnd(ctx.lines, toWordPos(ctx.from), steps(count), bigWord)),
      ),
  }
}

/** Vim's `j`/`k` fail without moving when there is nowhere to go, and so does `dj`/`dk`. */
function failsWhenStationary(
  resolve: VimMotionDef['resolve'],
): NonNullable<VimMotionDef['resolveForOperator']> {
  return (ctx, count) => {
    const to = resolve(ctx, count)
    return to === null || to.line === ctx.from.line ? null : { to, kind: 'linewise' }
  }
}

/**
 * Vim's `findpar`: from the cursor line, skip to the next blank line that follows at
 * least one non-blank line, `count` times. Fails (null) when a counted step runs off the buffer.
 */
function findParagraph(
  lines: VimLineReader,
  from: number,
  direction: 1 | -1,
  count: number,
): number | null {
  const lineCount = lines.getLineCount()
  let line = from
  for (let remaining = steps(count); remaining > 0; remaining--) {
    let sawText = false
    for (let first = true; ; first = false) {
      const blank = lines.getLineContent(line).trim() === ''
      if (!blank) sawText = true
      if (!first && sawText && blank) break
      line += direction
      if (line < 1 || line > lineCount) {
        if (remaining > 1) return null
        line -= direction
        break
      }
    }
  }
  return line
}

/**
 * `}` / `{` are exclusive charwise motions. Ending on the buffer's last line makes
 * `}` land on its last character, inclusive; otherwise it stops in column 1 of the
 * blank line, and `buildOperatorRange` applies Vim's "exclusive to linewise" rule.
 */
function paragraphTarget(ctx: VimMotionContext, count: number, direction: 1 | -1) {
  const line = findParagraph(ctx.lines, ctx.from.line, direction, count)
  if (line === null) return null
  const length = ctx.lines.getLineContent(line).length
  if (direction === 1 && line === ctx.lines.getLineCount() && length > 0) {
    return { to: { line, column: length }, kind: 'inclusive' as const }
  }
  return { to: { line, column: 1 }, kind: 'exclusive' as const }
}

function paragraphMotion(id: '{' | '}'): VimMotionDef {
  const direction = id === '}' ? 1 : -1
  return {
    id,
    keys: [id],
    kind: 'exclusive',
    description: direction === 1 ? 'Next paragraph' : 'Previous paragraph',
    resolve: (ctx, count) => paragraphTarget(ctx, count, direction)?.to ?? null,
    resolveForOperator: (ctx, count) => paragraphTarget(ctx, count, direction),
  }
}

function pageMotion(
  id: VimMotion,
  delta: 1 | -1,
  divisor: number,
  helpKeys: string,
  description: string,
): VimMotionDef {
  return {
    id,
    keys: [],
    kind: 'linewise',
    description,
    helpKeys,
    screenAware: true,
    resolve: (ctx) => {
      const rows = ctx.screen.pageRows?.()
      if (rows === undefined) return null
      const line = ctx.screen.advanceRows(
        ctx.from.line,
        delta,
        Math.max(1, Math.floor(rows / divisor)),
      )
      return clampNormalPosition(ctx.lines, { line, column: ctx.from.column })
    },
  }
}

function lineMotion(
  id: VimMotion,
  keys: readonly string[],
  delta: 1 | -1,
  description: string,
): VimMotionDef {
  const resolve: VimMotionDef['resolve'] = (ctx, count) =>
    clampNormalPosition(ctx.lines, {
      line: ctx.screen.advanceRows(ctx.from.line, delta, steps(count)),
      column: ctx.from.column,
    })
  return {
    id,
    keys,
    kind: 'linewise',
    description,
    screenAware: true,
    resolve,
    resolveForOperator: failsWhenStationary(resolve),
  }
}

/**
 * `gj` / `gk` count display rows: soft-wrapped segments and closed folds
 * (one row) rather than model lines. With `wrap` off they behave exactly like
 * `j` / `k`, including Vim's linewise operator semantics; with `wrap` on an
 * operator gets an exclusive target (Vim 9.1 behavior).
 */
function displayLineMotion(id: 'gj' | 'gk', delta: 1 | -1, description: string): VimMotionDef {
  const lineTarget = (ctx: VimMotionContext, count: number): VimPosition =>
    clampNormalPosition(ctx.lines, {
      line: ctx.screen.advanceRows(ctx.from.line, delta, steps(count)),
      column: ctx.from.column,
    })

  const displayMove = (ctx: VimMotionContext, count: number): VimDisplayMove | null => {
    if (ctx.screen.wrapsLines?.() !== true || ctx.screen.advanceDisplayRows === undefined) {
      return null
    }
    const preferred = ctx.displayOffset ?? ctx.screen.displayOffsetAt?.(ctx.from) ?? 0
    return ctx.screen.advanceDisplayRows(ctx.from, delta, steps(count), preferred)
  }

  return {
    id,
    keys: [],
    helpKeys: id,
    kind: 'exclusive',
    description,
    screenAware: true,
    resolve: (ctx, count) => {
      const display = displayMove(ctx, count)
      return display === null
        ? lineTarget(ctx, count)
        : clampNormalPosition(ctx.lines, display.position)
    },
    resolveForOperator: (ctx, count) => {
      const display = displayMove(ctx, count)
      if (display !== null) {
        return display.moved ? { to: display.position, kind: 'exclusive' } : null
      }
      const to = lineTarget(ctx, count)
      if (to.line === ctx.from.line) return null
      // Without display geometry the cursor still moves line-wise, but the
      // operator kind must follow the 'wrap' option, not the fallback path.
      return { to, kind: ctx.screen.wrapsLines?.() === true ? 'exclusive' : 'linewise' }
    },
  }
}

function gotoLine(ctx: VimMotionContext, line: number): VimPosition {
  const target = Math.max(1, Math.min(ctx.lines.getLineCount(), line))
  return clampNormalPosition(ctx.lines, {
    line: target,
    column: firstNonBlankColumn(ctx.lines.getLineContent(target)),
  })
}

const OPPOSITE_FIND: Record<VimFindMotion, VimFindMotion> = { f: 'F', F: 'f', t: 'T', T: 't' }

/**
 * `fx` / `Fx` / `tx` / `Tx` (and `;` / `,`) on the cursor line. `repeat` is `;`/`,`:
 * a repeated till-motion that already sits in front of the character skips it
 * instead of standing still.
 */
function resolveFind(
  ctx: VimMotionContext,
  count: number,
  motion: VimFindMotion,
  char: string | undefined,
  repeat: boolean,
): VimOperatorTarget | null {
  if (char === undefined || char === '') return null
  const text = ctx.lines.getLineContent(ctx.from.line)
  const forward = motion === 'f' || motion === 't'
  const till = motion === 't' || motion === 'T'
  const step = forward ? 1 : -1
  const origin = ctx.from.column - 1
  const skipAdjacent = repeat && till && steps(count) === 1 && text.startsWith(char, origin + step)
  let remaining = steps(count)
  let hit = -1
  const first = origin + step + (skipAdjacent ? step : 0)
  for (let index = first; index >= 0 && index < text.length; index += step) {
    if (text.startsWith(char, index) && --remaining === 0) {
      hit = index
      break
    }
  }
  if (hit < 0) return null
  return {
    to: { line: ctx.from.line, column: (till ? hit - step : hit) + 1 },
    kind: forward ? 'inclusive' : 'exclusive',
  }
}

const FIND_DESCRIPTIONS: Record<VimFindMotion, string> = {
  f: 'To the next occurrence of a character on the line',
  F: 'To the previous occurrence of a character on the line',
  t: 'Till just before the next occurrence of a character',
  T: 'Till just after the previous occurrence of a character',
}

function findMotion(id: VimFindMotion): VimMotionDef {
  const forward = id === 'f' || id === 't'
  const run = (ctx: VimMotionContext, count: number) => resolveFind(ctx, count, id, ctx.char, false)
  return {
    id,
    keys: [id],
    kind: forward ? 'inclusive' : 'exclusive',
    description: FIND_DESCRIPTIONS[id],
    needsChar: true,
    resolve: (ctx, count) => run(ctx, count)?.to ?? null,
    resolveForOperator: run,
  }
}

function repeatFindMotion(id: ';' | ','): VimMotionDef {
  const run = (ctx: VimMotionContext, count: number) => {
    const last = ctx.lastFind
    if (last === null || last === undefined) return null
    const motion = id === ';' ? last.motion : OPPOSITE_FIND[last.motion]
    return resolveFind(ctx, count, motion, last.char, true)
  }
  return {
    id,
    keys: [id],
    kind: 'inclusive',
    description:
      id === ';' ? 'Repeat the last f/F/t/T' : 'Repeat the last f/F/t/T in the opposite direction',
    resolve: (ctx, count) => run(ctx, count)?.to ?? null,
    resolveForOperator: run,
  }
}

const OPEN_BRACKETS = '([{'
const CLOSE_BRACKETS = ')]}'

/** The bracket matching the one at `from` (or the first one after it on the line); `null` if unbalanced. */
export function findMatchingBracket(lines: VimLineReader, from: VimPosition): VimPosition | null {
  const text = lines.getLineContent(from.line)
  let column = from.column - 1
  const isBracket = (ch: string | undefined): boolean =>
    ch !== undefined && (OPEN_BRACKETS.includes(ch) || CLOSE_BRACKETS.includes(ch))
  while (column < text.length && !isBracket(text[column])) column++
  if (column >= text.length) return null
  const bracket = text[column]!
  const forward = OPEN_BRACKETS.includes(bracket)
  const partner = forward
    ? CLOSE_BRACKETS[OPEN_BRACKETS.indexOf(bracket)]!
    : OPEN_BRACKETS[CLOSE_BRACKETS.indexOf(bracket)]!
  const lineCount = lines.getLineCount()
  const delta = forward ? 1 : -1
  let depth = 0
  let line = from.line
  let current = text
  let index = column
  for (;;) {
    const ch = current[index]
    if (ch === bracket) depth++
    else if (ch === partner && --depth === 0) return { line, column: index + 1 }
    index += delta
    while (index < 0 || index >= current.length) {
      line += delta
      if (line < 1 || line > lineCount) return null
      current = lines.getLineContent(line)
      index = forward ? 0 : current.length - 1
    }
  }
}

function bracketMatchMotion(): VimMotionDef {
  const resolve: VimMotionDef['resolve'] = (ctx, count) => {
    // `N%` is "N percent into the file", linewise.
    if (count > 0) return gotoLine(ctx, Math.ceil((count * ctx.lines.getLineCount()) / 100))
    return findMatchingBracket(ctx.lines, ctx.from)
  }
  return {
    id: '%',
    keys: ['%'],
    kind: 'inclusive',
    description: 'Jump to the matching bracket (N%: N percent into the file)',
    resolve,
    resolveForOperator: (ctx, count) => {
      const to = resolve(ctx, count)
      if (to === null) return null
      return { to, kind: count > 0 ? 'linewise' : 'inclusive' }
    },
  }
}

/** Every motion the Normal-mode reducer and the operators know. One entry per motion. */
export const VIM_MOTIONS: readonly VimMotionDef[] = [
  {
    id: 'h',
    keys: ['h'],
    description: 'Move left',
    kind: 'exclusive',
    resolve: (ctx, count) =>
      clampNormalPosition(ctx.lines, {
        line: ctx.from.line,
        column: ctx.from.column - steps(count),
      }),
    // dh at column 1 fails: no empty range, so the register stays untouched.
    resolveForOperator: (ctx, count) =>
      ctx.from.column <= 1
        ? null
        : {
            to: { line: ctx.from.line, column: Math.max(1, ctx.from.column - steps(count)) },
            kind: 'exclusive',
          },
  },
  {
    id: 'l',
    keys: ['l'],
    description: 'Move right',
    kind: 'exclusive',
    resolve: (ctx, count) =>
      clampNormalPosition(ctx.lines, {
        line: ctx.from.line,
        column: ctx.from.column + steps(count),
      }),
    // `dl` / `x` may take the last character, so the operator end can sit one past it.
    // On an empty line there is nothing to take: fail instead of an empty range.
    resolveForOperator: (ctx, count) =>
      ctx.lines.getLineContent(ctx.from.line).length === 0
        ? null
        : {
            to: {
              line: ctx.from.line,
              column: Math.min(
                ctx.lines.getLineContent(ctx.from.line).length + 1,
                ctx.from.column + steps(count),
              ),
            },
            kind: 'exclusive',
          },
  },
  lineMotion('j', ['j'], 1, 'Move down'),
  lineMotion('k', ['k'], -1, 'Move up'),
  displayLineMotion('gj', 1, 'Down one display line'),
  displayLineMotion('gk', -1, 'Up one display line'),
  {
    id: 'enter',
    keys: [],
    helpKeys: 'Enter',
    description: 'Down to the first non-blank of the next line',
    kind: 'linewise',
    screenAware: true,
    resolve: (ctx, count) => {
      const line = ctx.screen.advanceRows(ctx.from.line, 1, steps(count))
      // At the end of the buffer (or of a fold reaching it) `<CR>` fails in place.
      if (line === ctx.from.line) return clampNormalPosition(ctx.lines, ctx.from)
      return gotoLine(ctx, line)
    },
    resolveForOperator: (ctx, count) => {
      const line = ctx.screen.advanceRows(ctx.from.line, 1, steps(count))
      return line === ctx.from.line ? null : { to: { line, column: 1 }, kind: 'linewise' }
    },
  },
  {
    id: '0',
    keys: ['0'],
    description: 'Start of line',
    kind: 'exclusive',
    resolve: (ctx) => clampNormalPosition(ctx.lines, { line: ctx.from.line, column: 1 }),
  },
  {
    id: '^',
    keys: ['^'],
    description: 'First non-blank character of the line',
    kind: 'exclusive',
    resolve: (ctx) =>
      clampNormalPosition(ctx.lines, {
        line: ctx.from.line,
        column: firstNonBlankColumn(ctx.lines.getLineContent(ctx.from.line)),
      }),
  },
  {
    id: '$',
    keys: ['$'],
    description: 'End of line (with a count, N-1 lines down)',
    kind: 'inclusive',
    resolve: (ctx, count) => {
      // `N$` drops N-1 lines first, then stops on the last character there.
      const line = Math.max(1, Math.min(ctx.lines.getLineCount(), ctx.from.line + steps(count) - 1))
      return clampNormalPosition(ctx.lines, {
        line,
        column: Math.max(1, ctx.lines.getLineContent(line).length),
      })
    },
  },
  {
    id: 'gg',
    keys: [],
    helpKeys: 'gg',
    description: 'First line (or line N)',
    kind: 'linewise',
    // A count is a line number for gg/G, not a repetition.
    resolve: (ctx, count) => gotoLine(ctx, count > 0 ? count : 1),
  },
  {
    id: 'G',
    keys: ['G'],
    description: 'Last line (or line N)',
    kind: 'linewise',
    resolve: (ctx, count) => gotoLine(ctx, count > 0 ? count : ctx.lines.getLineCount()),
  },
  paragraphMotion('{'),
  paragraphMotion('}'),
  wordForwardMotion('w'),
  wordForwardMotion('W'),
  wordBackwardMotion('b'),
  wordBackwardMotion('B'),
  wordEndMotion('e'),
  wordEndMotion('E'),
  pageMotion('pageDown', 1, 1, 'Ctrl+F / PageDown', 'Page down'),
  pageMotion('pageUp', -1, 1, 'Ctrl+B / PageUp', 'Page up'),
  pageMotion('halfPageDown', 1, 2, 'Ctrl+D', 'Half page down'),
  pageMotion('halfPageUp', -1, 2, 'Ctrl+U', 'Half page up'),
  findMotion('f'),
  findMotion('F'),
  findMotion('t'),
  findMotion('T'),
  repeatFindMotion(';'),
  repeatFindMotion(','),
  bracketMatchMotion(),
]

const MOTIONS_BY_ID = new Map<VimMotion, VimMotionDef>(VIM_MOTIONS.map((def) => [def.id, def]))
const MOTIONS_BY_KEY = new Map<string, VimMotionDef>(
  VIM_MOTIONS.flatMap((def) => def.keys.map((key) => [key, def] as const)),
)

export function getVimMotion(id: VimMotion): VimMotionDef {
  const def = MOTIONS_BY_ID.get(id)
  if (def === undefined) throw new Error(`[vim] motion "${id}" is not registered`)
  return def
}

/** The motion a bare Normal-mode key triggers, if any. */
export function findVimMotionByKey(key: string): VimMotionDef | undefined {
  return MOTIONS_BY_KEY.get(key)
}
