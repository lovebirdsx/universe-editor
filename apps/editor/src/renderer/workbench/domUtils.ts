/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Small DOM predicates shared across the workbench keyboard layers.
 *--------------------------------------------------------------------------------------------*/

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
