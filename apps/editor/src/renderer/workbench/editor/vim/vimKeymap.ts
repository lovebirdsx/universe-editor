/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Normal/Insert reducer. Pure: it turns one keystroke plus the previous state
 *  into the next state and at most one command. Insert mode passes everything
 *  except Escape through untouched; Normal mode swallows every printable key so
 *  a stray letter never reaches the buffer, even when it maps to no command.
 *--------------------------------------------------------------------------------------------*/

import {
  INITIAL_VIM_STATE,
  type VimCommand,
  type VimKeyInput,
  type VimKeyResult,
  type VimMotion,
  type VimOperator,
  type VimState,
} from './vimTypes.js'

const MOTION_KEYS = new Set<string>([
  'h',
  'j',
  'k',
  'l',
  'w',
  'b',
  'e',
  'W',
  'B',
  'E',
  '^',
  'G',
  '$',
  '{',
  '}',
])

function idle(state: VimState): VimState {
  return {
    ...state,
    count: 0,
    pendingOperator: null,
    pendingG: false,
    countAfterOperator: false,
  }
}

function emit(state: VimState, command: VimCommand): VimKeyResult {
  return { state: idle(state), command, handled: true }
}

function motion(state: VimState, key: VimMotion): VimKeyResult {
  if (state.pendingOperator !== null) {
    return emit(state, {
      type: 'operator',
      operator: state.pendingOperator,
      motion: key,
      count: state.count,
    })
  }
  return emit(state, { type: 'motion', motion: key, count: state.count })
}

/** Paging strokes the controller hands to Monaco's viewport-relative commands. */
export function isVimPagingStroke(e: {
  readonly key: string
  readonly ctrlKey: boolean
  readonly altKey: boolean
  readonly metaKey: boolean
  readonly shiftKey?: boolean
}): boolean {
  // Shift variants are different commands (`Ctrl+Shift+F` = Find in Files,
  // `Ctrl+Shift+U` = Output, Linux `Ctrl+Shift+D` = Copy Line Down) and stay
  // with the workbench.
  if (!e.ctrlKey || e.altKey || e.metaKey || e.shiftKey === true) return false
  const key = e.key.toLowerCase()
  return key === 'f' || key === 'b' || key === 'd' || key === 'u'
}

export function pagingMotion(key: string): VimMotion {
  switch (key.toLowerCase()) {
    case 'f':
      return 'pageDown'
    case 'b':
      return 'pageUp'
    case 'd':
      return 'halfPageDown'
    default:
      return 'halfPageUp'
  }
}

export function reduceVimKey(state: VimState, input: VimKeyInput): VimKeyResult {
  if (state.mode === 'insert') {
    if (input.key === 'Escape' && !input.ctrl && !input.alt && !input.meta) {
      return { state: { ...INITIAL_VIM_STATE, mode: 'normal' }, command: null, handled: true }
    }
    return { state, command: null, handled: false }
  }

  if (input.ctrl && !input.alt && !input.meta) {
    if (
      isVimPagingStroke({
        key: input.key,
        ctrlKey: true,
        altKey: false,
        metaKey: false,
        shiftKey: input.shift,
      })
    ) {
      return emit(state, { type: 'motion', motion: pagingMotion(input.key), count: state.count })
    }
    // Any other modified stroke aborts a pending operator/count (Vim: only a
    // motion or a count may follow an operator).
    return { state: idle(state), command: null, handled: false }
  }
  if (input.alt || input.meta) {
    return { state: idle(state), command: null, handled: false }
  }

  const key = input.key

  if (key === 'Escape') {
    return { state: idle(state), command: null, handled: true }
  }

  if (state.pendingG) {
    if (key === 'g') return motion(state, 'gg')
    return { state: idle(state), command: null, handled: true }
  }

  if (key === 'g') {
    return { state: { ...state, pendingG: true }, command: null, handled: true }
  }

  // A count may start with 1-9; a leading 0 is the line-start motion. After an
  // operator, `0` is a digit only once a count has already started there
  // (`d10w`) — otherwise it is the motion (`3d0`).
  const zeroIsDigit =
    state.countAfterOperator || (state.pendingOperator === null && state.count > 0)
  if (key >= '1' && key <= '9') {
    return {
      state: {
        ...state,
        count: state.count * 10 + Number(key),
        countAfterOperator: state.pendingOperator !== null,
      },
      command: null,
      handled: true,
    }
  }
  if (key === '0') {
    if (zeroIsDigit) {
      return { state: { ...state, count: state.count * 10 }, command: null, handled: true }
    }
    return motion(state, '0')
  }

  if (key === 'd' || key === 'c' || key === 'y') {
    const operator = key as VimOperator
    if (state.pendingOperator === operator) {
      return emit(state, {
        type: 'linewise',
        operator,
        count: Math.max(1, state.count),
      })
    }
    return {
      state: { ...state, pendingOperator: operator, countAfterOperator: false },
      command: null,
      handled: true,
    }
  }

  if (MOTION_KEYS.has(key)) {
    return motion(state, key as VimMotion)
  }

  switch (key) {
    case 'i':
      return emit(state, { type: 'enter-insert', placement: 'before' })
    case 'a':
      return emit(state, { type: 'enter-insert', placement: 'after' })
    case 'I':
      return emit(state, { type: 'enter-insert', placement: 'line-start' })
    case 'A':
      return emit(state, { type: 'enter-insert', placement: 'line-end' })
    case 'o':
      return emit(state, { type: 'enter-insert', placement: 'open-below' })
    case 'O':
      return emit(state, { type: 'enter-insert', placement: 'open-above' })
    case 'x':
      return emit(state, { type: 'delete-char', count: Math.max(1, state.count), backward: false })
    case 'X':
      return emit(state, { type: 'delete-char', count: Math.max(1, state.count), backward: true })
    case 'p':
      return emit(state, { type: 'paste', count: Math.max(1, state.count), before: false })
    case 'P':
      return emit(state, { type: 'paste', count: Math.max(1, state.count), before: true })
    case 'u':
      return emit(state, { type: 'undo' })
    case 'J':
      return emit(state, { type: 'join-lines', count: Math.max(1, state.count) })
    default:
      // An unimplemented Normal-mode key is still ours: swallow it so it never
      // types into the buffer.
      return { state: idle(state), command: null, handled: true }
  }
}
