/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Small key/event helpers shared by every Vim reducer and controller (the file
 *  editor and the read-only Output surface), so the two never drift apart on what
 *  counts as a function key, how counts accumulate or how a stroke is consumed.
 *--------------------------------------------------------------------------------------------*/

import type { VimKeyInput } from './vimTypes.js'

/**
 * `event.key` for non-text keys is an ASCII identifier (`ArrowDown`, `F2`,
 * `Shift`, `MediaPlayPause`). A printable character can be a surrogate pair
 * (`'😀'.length === 2`), so length alone must not decide.
 */
export function isFunctionKeyName(key: string): boolean {
  return key.length > 1 && /^[A-Za-z][A-Za-z0-9]*$/.test(key)
}

/** Beyond this a count is nonsense and risks float imprecision; typing more digits is a no-op. */
const MAX_COUNT = 99_999_999

/** Append one decimal digit to a count being typed (`1` then `0` → `10`). */
export function accumulateCount(count: number, digit: number): number {
  return Math.min(MAX_COUNT, count * 10 + digit)
}

export function isCountDigitKey(key: string): boolean {
  return key.length === 1 && key >= '1' && key <= '9'
}

/** IME composition keystrokes belong to the input method, never to Vim. */
export function isImeKeyEvent(event: Pick<KeyboardEvent, 'isComposing' | 'keyCode'>): boolean {
  return event.isComposing || event.keyCode === 229
}

/** Take a stroke away from Monaco, the workbench and every later listener. */
export function consumeEvent(
  event: Pick<Event, 'preventDefault' | 'stopPropagation'> & {
    stopImmediatePropagation(): void
  },
): void {
  event.preventDefault()
  event.stopPropagation()
  event.stopImmediatePropagation()
}

/** A single code point, i.e. text rather than a named key like `ArrowLeft`. */
function isSingleCharacterKey(key: string): boolean {
  return key.length > 0 && [...key].length === 1
}

/**
 * Whether `event` typed a character through AltGr (Windows reports it as Ctrl+Alt) or
 * macOS Option rather than pressed a chord. Without this, `{ } [ ] \ ~ @ |` on a
 * non-US layout look like Ctrl+Alt+key and leak into the buffer in Normal mode.
 * Plain ASCII letters/digits with Ctrl+Alt stay chords (`Ctrl+Alt+J` on a US layout).
 */
function isCharacterProducedByAltGr(event: KeyboardEvent): boolean {
  if (event.metaKey || !isSingleCharacterKey(event.key)) return false
  if (event.getModifierState?.('AltGraph') === true) return true
  if (/^[A-Za-z0-9]$/.test(event.key)) return false
  if (event.ctrlKey && event.altKey) return true
  // macOS Option composes non-ASCII text (`å`, `«`); ASCII punctuation with Alt stays a chord.
  return event.altKey && !event.ctrlKey && event.key.charCodeAt(0) > 0x7f
}

export function toVimKeyInput(event: KeyboardEvent): VimKeyInput {
  const text = isCharacterProducedByAltGr(event)
  return {
    key: event.key,
    ctrl: text ? false : event.ctrlKey,
    alt: text ? false : event.altKey,
    meta: event.metaKey,
    shift: event.shiftKey,
  }
}

/** Monaco `editorScroll` payload for `Ctrl+E` / `Ctrl+Y`: screen lines, cursor kept visible. */
export function scrollViewportPayload(
  direction: 'up' | 'down',
  count: number,
): {
  to: 'up' | 'down'
  by: 'wrappedLine'
  value: number
  revealCursor: true
  select: false
} {
  return {
    to: direction,
    by: 'wrappedLine',
    value: Math.max(1, count),
    revealCursor: true,
    select: false,
  }
}

/** Monaco `editorScroll` payload for `Ctrl+D/U/F/B`: visual rows, so wrapped lines cannot shrink a page. */
export function pageScrollPayload(
  direction: 'up' | 'down',
  fraction: 'half' | 'full',
  count: number,
): {
  to: 'up' | 'down'
  by: 'halfPage' | 'page'
  value: number
  revealCursor: true
  select: false
} {
  return {
    to: direction,
    by: fraction === 'half' ? 'halfPage' : 'page',
    value: Math.max(1, count),
    revealCursor: true,
    select: false,
  }
}
