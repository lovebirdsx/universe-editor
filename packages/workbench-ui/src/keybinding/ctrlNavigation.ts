/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ctrlNavigation — the Ctrl+letter movement aliases, and the rule both of their
 *  consumers use to decide which modifier shapes count as one.
 *
 *  Every list surface maps these strokes onto a direction: the quick pick's list,
 *  context menus, overlay pickers, trees, flat lists and the graph views. They
 *  have to agree, or the same stroke would step one and leave the other to the
 *  global keybinding handler.
 *
 *  `n`/`p` are the emacs pair; `j`/`k` the vim pair. Both are accepted so a list
 *  answers the same stroke whichever muscle memory the user brings. `Ctrl+K`
 *  cannot be a normal keybinding: the registry resolves chord prefixes before
 *  single strokes, so every `ctrl+k ...` chord would shadow it. Consumers claim
 *  these strokes on window capture instead (see `ctrlNavigationRegistry`).
 *--------------------------------------------------------------------------------------------*/

/**
 * The letters with a directional meaning; `n`/`j` = down, `p`/`k` = up,
 * `l`/`h` = right/left.
 */
export type CtrlNavigationKey = 'h' | 'j' | 'k' | 'l' | 'n' | 'p'

/** The direction a Ctrl navigation alias stands for. */
export type CtrlNavigationDirection = 'up' | 'down' | 'left' | 'right'

/**
 * Structural event shape, so a native `KeyboardEvent` and React's synthetic
 * `KeyboardEvent<T>` both satisfy it without a cast.
 */
export interface CtrlNavigationKeyEvent {
  readonly key: string
  readonly ctrlKey: boolean
  readonly altKey: boolean
  readonly metaKey: boolean
  readonly shiftKey: boolean
}

/**
 * The alias a stroke stands for, or `undefined` when it is not one of ours.
 *
 * Ctrl must be the *only* modifier held. Every extra stripe already names a
 * global command — Ctrl+Shift+P the command palette, Ctrl+Shift+N a new window,
 * Ctrl+Alt+… an AltGr character, Cmd+P quick open on macOS — so admitting them
 * here would silently take those away wherever this predicate is honoured.
 *
 * Matches on `e.key` lower-cased rather than `e.code`: that is the field the
 * keybinding registry reads, so a CapsLock `P` still resolves and a non-QWERTY
 * layout resolves to the letter it actually produced.
 */
export function ctrlNavigationKey(e: CtrlNavigationKeyEvent): CtrlNavigationKey | undefined {
  if (!e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return undefined
  const key = e.key.toLowerCase()
  return key === 'h' || key === 'j' || key === 'k' || key === 'l' || key === 'n' || key === 'p'
    ? key
    : undefined
}

/** The direction this stroke moves a list, or `undefined` when it is not an alias. */
export function ctrlNavigationDirection(
  e: CtrlNavigationKeyEvent,
): CtrlNavigationDirection | undefined {
  switch (ctrlNavigationKey(e)) {
    case 'n':
    case 'j':
      return 'down'
    case 'p':
    case 'k':
      return 'up'
    case 'h':
      return 'left'
    case 'l':
      return 'right'
    default:
      return undefined
  }
}
