/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Modifier keys of the user gesture (click) that triggered a command.
 *
 *  Generic surfaces (status bar, toolbars, menus) run commands with fixed
 *  arguments and cannot know a command's signature, so the click's modifiers
 *  travel as an ambient value instead. It is only set during the synchronous
 *  part of `fn` — a command handler must read it before its first `await`
 *  (the same rule as `ServicesAccessor`). It never crosses an RPC boundary.
 *--------------------------------------------------------------------------------------------*/

/** Structurally compatible with DOM `MouseEvent` / `KeyboardEvent`. */
export interface IInvocationModifiers {
  readonly ctrlKey?: boolean
  readonly metaKey?: boolean
  readonly altKey?: boolean
  readonly shiftKey?: boolean
}

let current: IInvocationModifiers | undefined

export function runWithInvocationModifiers<T>(
  mods: IInvocationModifiers | undefined,
  fn: () => T,
): T {
  const previous = current
  // Snapshot: React may pool/reuse the event object after the handler returns.
  current = mods
    ? {
        ctrlKey: mods.ctrlKey === true,
        metaKey: mods.metaKey === true,
        altKey: mods.altKey === true,
        shiftKey: mods.shiftKey === true,
      }
    : undefined
  try {
    return fn()
  } finally {
    current = previous
  }
}

export function getInvocationModifiers(): IInvocationModifiers | undefined {
  return current
}

/** Structurally compatible with DOM `KeyboardEvent`. */
export interface IEnterKeyEvent {
  readonly key: string
  readonly repeat?: boolean
  readonly shiftKey?: boolean
  readonly ctrlKey?: boolean
  readonly metaKey?: boolean
  readonly altKey?: boolean
}

/** Ctrl/Meta/Alt+Enter, never with Shift. Repeat is deliberately NOT filtered:
 *  menus must swallow a held key without re-running the row. */
export function isModifiedEnter(e: IEnterKeyEvent): boolean {
  return (
    e.key === 'Enter' &&
    e.shiftKey !== true &&
    (e.ctrlKey === true || e.metaKey === true || e.altKey === true)
  )
}

/** The open gesture: modified Enter ignoring auto-repeat. */
export function isOpenTargetEnter(e: IEnterKeyEvent): boolean {
  return e.repeat !== true && isModifiedEnter(e)
}
