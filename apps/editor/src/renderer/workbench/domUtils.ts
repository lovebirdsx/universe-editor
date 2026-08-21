/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Small DOM predicates shared across the workbench keyboard layers.
 *--------------------------------------------------------------------------------------------*/

import { E2E_PROBE_ENABLED_KEY } from '../../shared/e2e/contract.js'

/**
 * True when the event target is a native text-entry control (input / textarea /
 * select) or a contenteditable region — i.e. a place where bare character keys
 * mean "type", not "trigger a shortcut". Keyboard handlers that claim bare keys
 * (global keybindings, the markdown preview's vim navigation) must yield here so
 * typing into an in-preview find box or any embedded input still works.
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return target.isContentEditable
}

/**
 * Synthesized window-focus state: the window counts as focused only while the
 * document actually has focus AND is not hidden (minimized / background tab).
 * Single source of truth shared by MainThreadWindow and useWindowFocused. Under
 * E2E the window never grabs real focus (showInactive), so it is treated as
 * focused — it is the window the user/script is "looking at".
 */
export function isWindowFocused(): boolean {
  if (window[E2E_PROBE_ENABLED_KEY] === true) return true
  return document.hasFocus() && document.visibilityState !== 'hidden'
}
