/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  Per-document "a chord is pending" flag, shared by the global keybinding
 *  dispatcher and the two Vim keydown listeners. Without it, a Vim listener
 *  running on window capture would eat the second stroke of `Ctrl+K ...`
 *  before the dispatcher could complete the chord.
 *--------------------------------------------------------------------------------------------*/

const pendingDocuments = new Set<Document>()

export function setKeybindingChordPending(doc: Document, pending: boolean): void {
  if (pending) pendingDocuments.add(doc)
  else pendingDocuments.delete(doc)
}

export function isKeybindingChordPending(doc: Document): boolean {
  return pendingDocuments.has(doc)
}

export function __resetKeybindingChordStateForTests(): void {
  pendingDocuments.clear()
}
