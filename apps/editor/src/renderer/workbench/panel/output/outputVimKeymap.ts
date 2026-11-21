/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  A deliberately reduced Vim keymap for the read-only Output editor. It shares
 *  the Normal-mode scrolling vocabulary with file editors but none of their
 *  editing / search / Insert state — the buffer can never be modified, so the
 *  full `reduceVimKey` would only add commands this surface must not run.
 *--------------------------------------------------------------------------------------------*/

export interface OutputVimState {
  /** Accumulated count; 0 means "none entered". */
  readonly count: number
  /** `g` was pressed and we are waiting for the second `g`. */
  readonly pendingG: boolean
}

export const INITIAL_OUTPUT_VIM_STATE: OutputVimState = {
  count: 0,
  pendingG: false,
}

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

export interface OutputVimKeyInput {
  readonly key: string
  readonly ctrl: boolean
  readonly alt: boolean
  readonly meta: boolean
  readonly shift: boolean
}

export interface OutputVimKeyResult {
  readonly state: OutputVimState
  readonly command: OutputVimCommand | null
  /** Whether the stroke belongs to Vim and must be swallowed. */
  readonly handled: boolean
}

function emit(command: OutputVimCommand): OutputVimKeyResult {
  return { state: INITIAL_OUTPUT_VIM_STATE, command, handled: true }
}

function swallow(): OutputVimKeyResult {
  return { state: INITIAL_OUTPUT_VIM_STATE, command: null, handled: true }
}

/** Same rule as the file-editor keymap: `ArrowDown` is a key name, `😀` is text. */
function isFunctionKeyName(key: string): boolean {
  return key.length > 1 && /^[A-Za-z][A-Za-z0-9]*$/.test(key)
}

export function reduceOutputVimKey(
  state: OutputVimState,
  input: OutputVimKeyInput,
): OutputVimKeyResult {
  if (input.ctrl && !input.alt && !input.meta) {
    if (!input.shift) {
      const count = Math.max(1, state.count)
      switch (input.key.toLowerCase()) {
        case 'e':
          return emit({ type: 'scroll-viewport', direction: 'down', count })
        case 'y':
          return emit({ type: 'scroll-viewport', direction: 'up', count })
        case 'd':
          return emit({ type: 'page', direction: 'down', fraction: 'half', count })
        case 'u':
          return emit({ type: 'page', direction: 'up', fraction: 'half', count })
        case 'f':
          return emit({ type: 'page', direction: 'down', fraction: 'full', count })
        case 'b':
          return emit({ type: 'page', direction: 'up', fraction: 'full', count })
      }
    }
    // Other chords belong to the workbench / Monaco; a pending count does not
    // survive the detour.
    return { state: INITIAL_OUTPUT_VIM_STATE, command: null, handled: false }
  }
  if (input.alt || input.meta) {
    return { state: INITIAL_OUTPUT_VIM_STATE, command: null, handled: false }
  }

  const key = input.key

  // Escape stays with Monaco: the find widget's own Escape must close it.
  if (key === 'Escape') return { state: INITIAL_OUTPUT_VIM_STATE, command: null, handled: false }

  if (state.pendingG) {
    if (key === 'g') {
      return emit({
        type: 'goto',
        target: 'first',
        line: state.count > 0 ? state.count : null,
      })
    }
    if (isFunctionKeyName(key)) {
      return { state: INITIAL_OUTPUT_VIM_STATE, command: null, handled: false }
    }
    return swallow()
  }

  if (key === 'g') return { state: { ...state, pendingG: true }, command: null, handled: true }
  if (key === 'G') {
    return emit({
      type: 'goto',
      target: 'last',
      line: state.count > 0 ? state.count : null,
    })
  }
  if (key === 'j' || key === 'k') {
    return emit({
      type: 'move',
      direction: key === 'j' ? 'down' : 'up',
      count: Math.max(1, state.count),
    })
  }

  if (key >= '1' && key <= '9') {
    return {
      state: { count: state.count * 10 + Number(key), pendingG: false },
      command: null,
      handled: true,
    }
  }
  if (key === '0' && state.count > 0) {
    return {
      state: { count: state.count * 10, pendingG: false },
      command: null,
      handled: true,
    }
  }

  // Function keys (arrows, PageUp/Down, F-keys) keep their native meaning.
  if (isFunctionKeyName(key)) {
    return { state: INITIAL_OUTPUT_VIM_STATE, command: null, handled: false }
  }
  // Every other printable key is swallowed so a stray `d` cannot start an
  // operator the read-only surface has no business executing.
  return swallow()
}
