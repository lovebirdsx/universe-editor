/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Vim state that outlives one editor, as in Vim itself: the last repeatable change
 *  (`.`) and the last `f`/`t` search (`;` / `,`). Window-wide like the registers,
 *  so a change made in one split repeats in another.
 *--------------------------------------------------------------------------------------------*/

import type { VimCommand, VimFindState, VimLastChange, VimMotion } from './vimTypes.js'

/** One keystroke of an Insert session, replayed through Monaco's own editing commands. */
export type VimInsertOp =
  | { readonly kind: 'type'; readonly text: string }
  | { readonly kind: 'delete-left' }
  | { readonly kind: 'delete-right' }
  | { readonly kind: 'tab' }

/**
 * What `.` replays after the change that opened an Insert session. `keys` is the
 * typed key stream (so auto-indent / auto-close fire again, like Vim's redo
 * buffer); `literal` is the net text, used when the stream cannot be trusted (IME
 * composition, Ctrl chords, programmatic input).
 */
export type VimInsertReplay =
  | { readonly keys: readonly VimInsertOp[] }
  | { readonly literal: string }

let lastChange: VimLastChange | null = null
let lastInsertReplay: VimInsertReplay | null = null
let lastFind: VimFindState | null = null

export function getLastVimChange(): VimLastChange | null {
  return lastChange
}

export function getLastVimInsertReplay(): VimInsertReplay | null {
  return lastInsertReplay
}

/** `insertReplay` is the typed text of the Insert session the change opened, if any. */
export function setLastVimChange(
  next: VimLastChange | null,
  insertReplay: VimInsertReplay | null = null,
): void {
  lastChange = next
  lastInsertReplay = next === null ? null : insertReplay
}

export function getLastVimFind(): VimFindState | null {
  return lastFind
}

export function setLastVimFind(next: VimFindState): void {
  lastFind = next
}

export function resetVimSessionForTests(): void {
  lastChange = null
  lastInsertReplay = null
  lastFind = null
}

/** The plain text of a replay (type ops joined); backspaces and the like contribute nothing. */
export function insertReplayText(replay: VimInsertReplay): string {
  if ('literal' in replay) return replay.literal
  return replay.keys.map((op) => (op.kind === 'type' ? op.text : '')).join('')
}

const FIND_MOTIONS: ReadonlySet<VimMotion> = new Set(['f', 'F', 't', 'T'])

/** Remember `fx`/`Tx` so `;` and `,` can repeat them. */
export function recordFind(motion: VimMotion, char: string | undefined): void {
  if (char !== undefined && FIND_MOTIONS.has(motion)) {
    setLastVimFind({ motion: motion as VimFindState['motion'], char })
  }
}

/** Commands that change the buffer and therefore replay with `.`; yanks and moves do not. */
export function isRepeatableChange(command: VimCommand): boolean {
  switch (command.type) {
    case 'operator':
    case 'operator-textobject':
    case 'linewise':
      return command.operator !== 'y'
    case 'visual-action':
      return command.action !== 'yank'
    case 'enter-insert':
    case 'delete-char':
    case 'substitute-char':
    case 'paste':
    case 'join-lines':
    case 'replace-char':
    case 'toggle-case':
      return true
    default:
      return false
  }
}

/**
 * Commands a read-only buffer must refuse: everything `.` can replay plus the
 * history and block-insert commands (yanks, motions and editor actions stay).
 */
export function isWriteCommand(command: VimCommand): boolean {
  return (
    isRepeatableChange(command) ||
    command.type === 'undo' ||
    command.type === 'redo' ||
    command.type === 'visual-block-insert'
  )
}

/** `3.` replaces the stored count with 3; commands without a count are returned as-is. */
export function withCount(command: VimCommand, count: number): VimCommand {
  switch (command.type) {
    case 'operator':
    case 'operator-textobject':
    case 'linewise':
    case 'delete-char':
    case 'substitute-char':
    case 'paste':
    case 'join-lines':
    case 'replace-char':
    case 'toggle-case':
      return { ...command, count }
    case 'enter-insert':
      return count > 1 ? { ...command, count } : command
    default:
      return command
  }
}
