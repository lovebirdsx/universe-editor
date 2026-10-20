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

import { markAsSingleton, toDisposable, type IDisposable } from '@universe-editor/platform'
import {
  getWorkbenchDocuments,
  onDidAddWorkbenchDocument,
  onDidRemoveWorkbenchDocument,
} from '../windows/workbenchDocuments.js'

export function installDocumentFocusReconcile(reconcile: () => void): IDisposable {
  let timer: ReturnType<typeof setTimeout> | undefined
  const onFocusOut = (): void => {
    if (timer !== undefined) return
    timer = setTimeout(() => {
      timer = undefined
      reconcile()
    }, 0)
  }
  // Auxiliary windows are separate documents. Their focus events never reach the
  // main document, so deriving DOM-based keys requires listening on each one.
  const attached = new Set<Document>()
  const attach = (doc: Document): void => {
    if (attached.has(doc)) return
    attached.add(doc)
    doc.addEventListener('focusin', reconcile, true)
    doc.addEventListener('focusout', onFocusOut, true)
  }
  const detach = (doc: Document): void => {
    if (!attached.delete(doc)) return
    doc.removeEventListener('focusin', reconcile, true)
    doc.removeEventListener('focusout', onFocusOut, true)
  }
  // The main renderer document is the fallback owner even before (or without)
  // the window registry publishing it — unit tests and early startup rely on it.
  attach(document)
  for (const doc of getWorkbenchDocuments()) attach(doc)
  const addSub = markAsSingleton(onDidAddWorkbenchDocument(attach))
  const removeSub = markAsSingleton(onDidRemoveWorkbenchDocument(detach))
  return toDisposable(() => {
    addSub.dispose()
    removeSub.dispose()
    for (const doc of attached) detach(doc)
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
  })
}
