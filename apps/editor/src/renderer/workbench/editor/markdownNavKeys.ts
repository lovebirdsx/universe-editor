/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Vimium-style key resolution for the markdown preview. A tiny state machine
 *  that folds keystrokes into navigation commands, supporting a numeric count
 *  prefix (`3j`) and the two-char `gg` chord. Pure — no DOM, no scrolling — so
 *  the parsing rules are unit-testable in isolation; the hook applies the
 *  resulting command to the live scroll container.
 *--------------------------------------------------------------------------------------------*/

export type NavCommand =
  | { readonly type: 'scrollLine'; readonly dir: 1 | -1; readonly count: number }
  | { readonly type: 'scrollHoriz'; readonly dir: 1 | -1; readonly count: number }
  | { readonly type: 'scrollHalfPage'; readonly dir: 1 | -1; readonly count: number }
  | { readonly type: 'scrollFullPage'; readonly dir: 1 | -1 }
  | { readonly type: 'scrollToTop' }
  | { readonly type: 'scrollToBottom' }
  | { readonly type: 'goBack' }
  | { readonly type: 'goForward' }

/** Mutable parsing state carried between keystrokes. */
export interface NavKeyState {
  /** Accumulated numeric count prefix (0 = none typed yet). */
  readonly count: number
  /** True after a lone `g`, waiting for the second `g` of `gg`. */
  readonly pendingG: boolean
}

export const INITIAL_NAV_STATE: NavKeyState = { count: 0, pendingG: false }

export interface NavKeyResult {
  /** The command to run, if this keystroke completed one. */
  readonly command?: NavCommand
  /** State to carry into the next keystroke. */
  readonly state: NavKeyState
  /** True when the key was consumed by the navigator (caller should preventDefault). */
  readonly handled: boolean
}

/**
 * Fold one key into the nav state. `key` is a KeyboardEvent.key value; `shift`
 * disambiguates Space vs Shift+Space (both report key === ' '). Modifier keys
 * (ctrl/alt/meta) are the caller's job to exclude before calling.
 */
export function reduceNavKey(state: NavKeyState, key: string, shift: boolean): NavKeyResult {
  const count = state.count > 0 ? state.count : 1

  // Numeric count prefix. Leading 0 is not a prefix (vimium rule); a 0 after a
  // prefix extends it. Digits never complete a command.
  if (key.length === 1 && key >= '0' && key <= '9') {
    if (key === '0' && state.count === 0) {
      return { state: INITIAL_NAV_STATE, handled: false }
    }
    return {
      state: { count: state.count * 10 + Number(key), pendingG: false },
      handled: true,
    }
  }

  // Second `g` of the `gg` chord → scroll to top.
  if (state.pendingG) {
    if (key === 'g') {
      return { command: { type: 'scrollToTop' }, state: INITIAL_NAV_STATE, handled: true }
    }
    // Any other key aborts the pending chord; fall through to re-interpret it
    // with a clean state so e.g. `gj` still scrolls down.
    return reduceNavKey(INITIAL_NAV_STATE, key, shift)
  }

  switch (key) {
    case 'j':
      return done({ type: 'scrollLine', dir: 1, count })
    case 'k':
      return done({ type: 'scrollLine', dir: -1, count })
    case 'h':
      return done({ type: 'scrollHoriz', dir: -1, count })
    case 'l':
      return done({ type: 'scrollHoriz', dir: 1, count })
    case 'd':
      return done({ type: 'scrollHalfPage', dir: 1, count })
    case 'u':
      return done({ type: 'scrollHalfPage', dir: -1, count })
    case ' ':
      return done({ type: 'scrollFullPage', dir: shift ? -1 : 1 })
    case 'G':
      return done({ type: 'scrollToBottom' })
    case 'H':
      return done({ type: 'goBack' })
    case 'L':
      return done({ type: 'goForward' })
    case 'g':
      // First `g`: wait for the second. Carry the count through the chord.
      return { state: { count: state.count, pendingG: true }, handled: true }
    default:
      // Unhandled key: reset so a stray key doesn't strand a count prefix.
      return { state: INITIAL_NAV_STATE, handled: false }
  }
}

function done(command: NavCommand): NavKeyResult {
  return { command, state: INITIAL_NAV_STATE, handled: true }
}
