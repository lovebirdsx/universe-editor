/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Small DOM predicates shared across the workbench keyboard layers.
 *--------------------------------------------------------------------------------------------*/

import { isEditableElement } from '@universe-editor/workbench-ui'
import { E2E_PROBE_ENABLED_KEY } from '../../shared/e2e/contract.js'

/**
 * True when the event target is a native text-entry control (input / textarea /
 * select) or a contenteditable region — i.e. a place where bare character keys
 * mean "type", not "trigger a shortcut". Keyboard handlers that claim bare keys
 * (global keybindings, the markdown preview's vim navigation) must yield here so
 * typing into an in-preview find box or any embedded input still works.
 *
 * 主 realm 的 `instanceof HTMLElement` 对辅助窗口元素恒为 false，曾让 dispatcher
 * 在辅助窗口吞掉 Ctrl+P/N（见 `domRealm`）。
 */
export function isEditableTarget(target: EventTarget | null): boolean {
  return isEditableElement(target)
}

/**
 * Synthesized window-focus state: the window counts as focused only while the
 * document actually has focus AND is not hidden (minimized / background tab).
 * Single source of truth shared by MainThreadWindow and useWindowFocused. Under
 * E2E the window never grabs real focus (showInactive), so it is treated as
 * focused — it is the window the user/script is "looking at".
 */
export function isWindowFocused(): boolean {
  return isDocumentFocused(typeof document === 'undefined' ? undefined : document)
}

/** {@link isWindowFocused} for an explicit workbench document (auxiliary windows). */
export function isDocumentFocused(doc: Document | undefined): boolean {
  if (typeof window !== 'undefined' && window[E2E_PROBE_ENABLED_KEY] === true) return true
  return doc?.hasFocus() === true && doc.visibilityState !== 'hidden'
}
