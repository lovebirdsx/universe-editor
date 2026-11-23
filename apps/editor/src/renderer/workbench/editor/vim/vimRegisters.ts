/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Vim registers, window-wide: the unnamed register (`""`), the yank register
 *  (`"0`), the numbered delete registers (`"1`-`"9`), the small delete register
 *  (`"-`), named registers (`"a`-`"z`, an uppercase name appends) and the black
 *  hole (`"_`). The system clipboard registers (`"+`, `"*`) are asynchronous and
 *  live in the controller; this module only recognizes their names.
 *
 *  Every write also lands in the unnamed register, as in Vim (it "points at" the
 *  last register written). Only a yank without an explicit register fills `"0`.
 *  A delete or change that spans a line break (or whole lines) shifts `"1`-`"9`;
 *  a smaller one without an explicit register goes to `"-`. Vim's exception that
 *  `d%` `d/` `dn` `d{`… always use `"1` is not modelled: the host does not pass
 *  the motion down here.
 *--------------------------------------------------------------------------------------------*/

export interface VimRegisterContent {
  readonly text: string
  readonly linewise: boolean
  /** Rectangular text from a Visual-block yank/delete; `text` holds one row per line. */
  readonly blockwise?: boolean
}

/** What produced the write: a yank also fills `"0`, a delete shifts `"1` or fills `"-`. */
export type VimRegisterOrigin = 'yank' | 'delete'

const NUMBERED_COUNT = 9

let unnamed: VimRegisterContent | null = null
let yankRegister: VimRegisterContent | null = null
let smallDelete: VimRegisterContent | null = null
/** `"1` is index 0. */
let numbered: (VimRegisterContent | null)[] = []
const named = new Map<string, VimRegisterContent>()

export function isVimClipboardRegister(name: string | null): boolean {
  return name === '+' || name === '*'
}

function isBlackHoleRegister(name: string | null): boolean {
  return name === '_'
}

/** Names `"x` accepts: letters, digits, the punctuation registers we implement. */
export function isValidVimRegisterName(name: string): boolean {
  return /^[a-zA-Z0-9"_+*-]$/.test(name)
}

/**
 * Text is stored with `\n` line breaks whatever the model's EOL was: a CRLF
 * buffer hands out `\r\n` from `getValueInRange`, and paste column math must not
 * see the stray `\r`. Monaco re-applies the target model's EOL on insert.
 */
function normalize(content: VimRegisterContent): VimRegisterContent {
  const text = content.text.replace(/\r\n?/g, '\n')
  return content.blockwise === true
    ? { text, linewise: content.linewise, blockwise: true }
    : { text, linewise: content.linewise }
}

/** `"Ax`: lines win over characters; an existing block stays a block (rows appended). */
function append(
  existing: VimRegisterContent | undefined,
  next: VimRegisterContent,
): VimRegisterContent {
  if (existing === undefined) return next
  if (existing.linewise || next.linewise) {
    const withBreak = (text: string): string => (text.endsWith('\n') ? text : `${text}\n`)
    return { text: withBreak(existing.text) + withBreak(next.text), linewise: true }
  }
  if (existing.blockwise === true) {
    return { text: `${existing.text}\n${next.text}`, linewise: false, blockwise: true }
  }
  return { text: existing.text + next.text, linewise: false }
}

/** Read a register; `null`/`"` is the unnamed one. Clipboard registers are not served here. */
export function getVimRegister(name: string | null = null): VimRegisterContent | null {
  if (name === null || name === '"') return unnamed
  if (name === '0') return yankRegister
  if (name === '-') return smallDelete
  if (name >= '1' && name <= '9') return numbered[Number(name) - 1] ?? null
  if (isBlackHoleRegister(name) || isVimClipboardRegister(name)) return null
  return named.get(name.toLowerCase()) ?? null
}

function shiftNumbered(content: VimRegisterContent): void {
  numbered = [content, ...numbered].slice(0, NUMBERED_COUNT)
}

/**
 * Store `next` into `name` (`null` or `"` = no register chosen). Returns the content the
 * unnamed register now holds, or `null` for the black hole, so callers can mirror
 * it to the system clipboard.
 */
export function setVimRegister(
  next: VimRegisterContent,
  name: string | null = null,
  origin: VimRegisterOrigin = 'yank',
): VimRegisterContent | null {
  if (isBlackHoleRegister(name)) return null
  const content = normalize(next)
  const register = name === '"' ? null : name
  if (register !== null && /^[a-zA-Z]$/.test(register)) {
    const key = register.toLowerCase()
    const stored = register === key ? content : append(named.get(key), content)
    named.set(key, stored)
    unnamed = stored
    // Vim shifts `"1` for a multi-line delete even when a register was named.
    if (origin === 'delete' && spansLines(content)) shiftNumbered(content)
    return stored
  }
  unnamed = content
  if (register === '0') yankRegister = content
  else if (register === '-') smallDelete = content
  else if (register !== null && register >= '1' && register <= '9') {
    const slot = Number(register) - 1
    numbered = Array.from({ length: Math.max(numbered.length, slot + 1) }, (_, i) =>
      i === slot ? content : (numbered[i] ?? null),
    )
  } else if (register === null) {
    if (origin === 'yank') yankRegister = content
    else if (spansLines(content)) shiftNumbered(content)
    else smallDelete = content
  }
  return content
}

function spansLines(content: VimRegisterContent): boolean {
  return content.linewise || content.text.includes('\n')
}

export function resetVimRegisterForTests(): void {
  unnamed = null
  yankRegister = null
  smallDelete = null
  numbered = []
  named.clear()
}
