/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  installDocumentFocusReconcile — "derive, don't book-keep" for DOM-derived
 *  context keys.
 *
 *  Keeps a reconcile callback in step with the document's own focus moves. Both
 *  rules are load-bearing, and both were learned the hard way in editorFocus.ts:
 *
 *  - focusin reconciles SYNCHRONOUSLY. The DOM already points at the new element
 *    when focusin fires, so a keybinding resolved in the same task as the click
 *    that moved focus reads the new value. Deferring here reopens the very
 *    race this exists to close.
 *  - focusout defers to a coalesced setTimeout(0). A move that lands on nothing
 *    focusable fires focusout with no focusin behind it and leaves activeElement
 *    on <body> for the rest of the task; other handlers reclaim focus from <body>
 *    in a microtask, and that reclaim has to land before the read. focusout
 *    itself reads nothing synchronously — during the pair activeElement is
 *    momentarily null.
 *
 *  No initial call: owners seed their own keys, and a construction-time read
 *  would run before the parts it reads have mounted.
 *--------------------------------------------------------------------------------------------*/

import { toDisposable, type IDisposable } from '@universe-editor/platform'

export function installDocumentFocusReconcile(reconcile: () => void): IDisposable {
  let timer: ReturnType<typeof setTimeout> | undefined
  const onFocusOut = (): void => {
    if (timer !== undefined) return
    timer = setTimeout(() => {
      timer = undefined
      reconcile()
    }, 0)
  }
  document.addEventListener('focusin', reconcile, true)
  document.addEventListener('focusout', onFocusOut, true)
  return toDisposable(() => {
    document.removeEventListener('focusin', reconcile, true)
    document.removeEventListener('focusout', onFocusOut, true)
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  })
}
