/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ctrlNavigation — the Ctrl+letter movement aliases, and the rule both of their
 *  consumers use to decide which modifier shapes count as one.
 *
 *  Two surfaces map a stroke onto a direction: the quick pick's list (Ctrl+P/N)
 *  and every context menu, through `useMenuNavigation` (Ctrl+P/N/H/L). They have
 *  to agree, or the same stroke would step one and leave the other to the global
 *  keybinding handler.
 *--------------------------------------------------------------------------------------------*/

/** The letters with a directional meaning; `n`/`p` = down/up, `l`/`h` = right/left. */
export type CtrlNavigationKey = 'h' | 'l' | 'n' | 'p'

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
  return key === 'h' || key === 'l' || key === 'n' || key === 'p' ? key : undefined
}
