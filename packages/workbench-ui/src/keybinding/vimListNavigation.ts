/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Bare-key Vim navigation for list surfaces. The editor's Normal mode owns the
 *  text buffer; this reducer gives trees, flat lists, overlays and menus the same
 *  hjkl / gg / G / Ctrl+d/u vocabulary while they hold focus, without a mode of
 *  their own (lists never insert text). Editable targets are rejected upstream by
 *  the registry, so a search box keeps typing.
 *--------------------------------------------------------------------------------------------*/

export type VimListDirection = 'up' | 'down' | 'left' | 'right'

export type VimListMotion =
  | { readonly kind: 'direction'; readonly direction: VimListDirection }
  | { readonly kind: 'first' }
  | { readonly kind: 'last' }
  | { readonly kind: 'page'; readonly direction: 'up' | 'down' }

export interface VimListState {
  readonly pendingG: boolean
}

export const INITIAL_VIM_LIST_STATE: VimListState = { pendingG: false }

export interface VimListKeyInput {
  readonly key: string
  readonly ctrl: boolean
  readonly alt: boolean
  readonly meta: boolean
  readonly shift: boolean
}

export interface VimListKeyOptions {
  readonly directions: readonly VimListDirection[]
  /** Whether gg/G are meaningful (lists with a first/last row always are). */
  readonly jumps: boolean
  /** Whether Ctrl+d/u page the list. */
  readonly paging: boolean
}

export interface VimListKeyResult {
  readonly state: VimListState
  readonly motion: VimListMotion | null
  readonly handled: boolean
}

const DIRECTION_KEYS: Readonly<Record<string, VimListDirection>> = {
  h: 'left',
  j: 'down',
  k: 'up',
  l: 'right',
}

const IDLE: VimListState = INITIAL_VIM_LIST_STATE

export function reduceVimListKey(
  state: VimListState,
  input: VimListKeyInput,
  options: VimListKeyOptions,
): VimListKeyResult {
  const emit = (motion: VimListMotion | null): VimListKeyResult => ({
    state: IDLE,
    motion,
    handled: true,
  })

  if (input.alt || input.meta) return { state, motion: null, handled: false }

  if (input.ctrl) {
    // Shift variants are different commands (`Ctrl+Shift+F` etc.) and stay with
    // the workbench, so paging only matches the bare Ctrl strokes.
    if (options.paging && !input.shift) {
      const key = input.key.toLowerCase()
      if (key === 'd') return emit({ kind: 'page', direction: 'down' })
      if (key === 'u') return emit({ kind: 'page', direction: 'up' })
    }
    return { state, motion: null, handled: false }
  }

  const key = input.key
  // Non-printable navigation keys — and Space, the list's preview/activate
  // gesture — stay with the list's own handler.
  if (
    key === 'Escape' ||
    key === 'Enter' ||
    key === 'Tab' ||
    key === ' ' ||
    key.startsWith('Arrow')
  ) {
    return { state: IDLE, motion: null, handled: false }
  }

  if (state.pendingG) {
    if (key === 'g' && options.jumps) return emit({ kind: 'first' })
    return { state: IDLE, motion: null, handled: true }
  }

  if (key === 'g' && options.jumps) {
    return { state: { pendingG: true }, motion: null, handled: true }
  }
  if (key === 'G' && options.jumps) {
    return emit({ kind: 'last' })
  }

  // Lists have no count prefix (their cursor is controlled by the host, so a
  // repeat would need a re-render between steps); digits are swallowed.
  if (key >= '0' && key <= '9') return emit(null)

  const direction = DIRECTION_KEYS[key]
  if (direction !== undefined) {
    return emit(options.directions.includes(direction) ? { kind: 'direction', direction } : null)
  }

  // Swallow every other printable Normal-mode key so it never reaches the list's
  // typeahead. Modified/non-printable keys fall through to the dispatcher.
  if (key.length === 1) return { state: IDLE, motion: null, handled: true }
  return { state, motion: null, handled: false }
}
