/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  The read-only Output editor's keymap: a projection of the file editor's
 *  `reduceVimKey`. Counts, `g` prefixes, motion keys and Ctrl chords are parsed by
 *  the one shared reducer, so the two surfaces cannot drift; this module only
 *  decides which of the resulting commands a read-only buffer may run (cursor
 *  moves, `gg`/`G`, paging, viewport scroll) and swallows the rest. To let Output
 *  run one more motion, add a `case` in `project` — never a second key table.
 *--------------------------------------------------------------------------------------------*/

import { isFunctionKeyName } from '../../editor/vim/vimKeyUtils.js'
import { idle, reduceVimKey } from '../../editor/vim/vimKeymap.js'
import {
  INITIAL_VIM_STATE,
  type VimCommand,
  type VimKeyInput,
  type VimState,
} from '../../editor/vim/vimTypes.js'

export type OutputVimState = VimState
export type OutputVimKeyInput = VimKeyInput

export const INITIAL_OUTPUT_VIM_STATE: OutputVimState = INITIAL_VIM_STATE

export type OutputVimCommand =
  | { readonly type: 'move'; readonly direction: 'up' | 'down'; readonly count: number }
  | {
      readonly type: 'scroll-viewport'
      readonly direction: 'up' | 'down'
      readonly count: number
    }
  | {
      readonly type: 'page'
      readonly direction: 'up' | 'down'
      readonly fraction: 'half' | 'full'
      readonly count: number
    }
  /** `gg` / `G`; a count is a target line number, like Vim. */
  | { readonly type: 'goto'; readonly target: 'first' | 'last'; readonly line: number | null }

export interface OutputVimKeyResult {
  readonly state: OutputVimState
  readonly command: OutputVimCommand | null
  /** Whether the stroke belongs to Vim and must be swallowed. */
  readonly handled: boolean
}

/** The subset of reducer commands a read-only buffer can execute; `null` means "swallow". */
function project(command: VimCommand): OutputVimCommand | null {
  switch (command.type) {
    case 'scroll-viewport':
      return { type: 'scroll-viewport', direction: command.direction, count: command.count }
    case 'motion': {
      const count = Math.max(1, command.count)
      switch (command.motion) {
        case 'j':
          return { type: 'move', direction: 'down', count }
        case 'k':
          return { type: 'move', direction: 'up', count }
        case 'gg':
        case 'G':
          return {
            type: 'goto',
            target: command.motion === 'gg' ? 'first' : 'last',
            line: command.count > 0 ? command.count : null,
          }
        case 'pageDown':
          return { type: 'page', direction: 'down', fraction: 'full', count }
        case 'pageUp':
          return { type: 'page', direction: 'up', fraction: 'full', count }
        case 'halfPageDown':
          return { type: 'page', direction: 'down', fraction: 'half', count }
        case 'halfPageUp':
          return { type: 'page', direction: 'up', fraction: 'half', count }
        default:
          return null
      }
    }
    default:
      return null
  }
}

function passthrough(): OutputVimKeyResult {
  return { state: idle(INITIAL_OUTPUT_VIM_STATE), command: null, handled: false }
}

export function reduceOutputVimKey(
  state: OutputVimState,
  input: OutputVimKeyInput,
): OutputVimKeyResult {
  // Escape stays with Monaco (the find widget's own Escape must close it), and
  // function keys (arrows, PageUp/Down, F-keys) keep their native meaning.
  const isEscape = input.key === 'Escape' || (input.ctrl && input.key === '[')
  if (isEscape || isFunctionKeyName(input.key)) return passthrough()

  const result = reduceVimKey(state, input)
  if (!result.handled) return passthrough()

  // An operator, or a prefix other than `g`, would wait for a key this surface
  // can never act on: drop it so the next stroke starts clean.
  const next = result.state
  // A read-only buffer has no Visual / Insert mode: `v` would leave the state in a
  // mode whose keys (`d`, `y`, `<Esc>`) this surface cannot run, so refuse the switch.
  if (next.mode !== 'normal') {
    return { state: { ...idle(next), mode: 'normal' }, command: null, handled: true }
  }
  const dangling =
    next.pendingOperator !== null || (next.pending !== null && next.pending.kind !== 'g')
  if (dangling) return { state: idle(next), command: null, handled: true }

  return {
    state: next,
    command: result.command === null ? null : project(result.command),
    handled: true,
  }
}
