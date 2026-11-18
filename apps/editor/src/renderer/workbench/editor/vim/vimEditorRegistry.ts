/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *
 *  One window-capture listener per document that routes Normal-mode strokes to
 *  the Vim controller whose editor holds text focus. Window capture is required:
 *  the global dispatcher listens on document capture and would otherwise run
 *  Find / Toggle Panel / Add Selection for Ctrl+F/B/D/U before Monaco sees them.
 *
 *  The registry also yields while a chord is pending (`Ctrl+K ...`) so the
 *  dispatcher can complete it, and while a modal dialog or menu is open, whose
 *  virtual focus can leave DOM focus on the editor text underneath.
 *--------------------------------------------------------------------------------------------*/

import { isKeybindingChordPending } from '@universe-editor/workbench-ui'
import type { IVimEditorController } from './vimEditorController.js'

interface VimEditorEntry {
  readonly controller: IVimEditorController
  readonly sequence: number
}

interface DocumentState {
  readonly view: Window
  readonly entries: Set<VimEditorEntry>
  readonly listener: (event: KeyboardEvent) => void
}

const documents = new Map<Document, DocumentState>()
let nextSequence = 1

function hasModalSurface(doc: Document): boolean {
  return doc.querySelector('[data-renderer-dialog], [role="menu"]') !== null
}

function handleKeyDown(state: DocumentState, doc: Document, event: KeyboardEvent): void {
  if (event.defaultPrevented) return
  if (event.isComposing || event.keyCode === 229) return
  if (isKeybindingChordPending(doc)) return
  if (hasModalSurface(doc)) return
  const active = doc.activeElement
  if (active === null) return

  let target: VimEditorEntry | undefined
  for (const entry of state.entries) {
    if (!entry.controller.isEnabled() || !entry.controller.hasTextFocus()) continue
    if (!entry.controller.editor.getContainerDomNode().contains(active)) continue
    if (target === undefined || entry.sequence > target.sequence) target = entry
  }
  target?.controller.handleKeyDown(event)
}

function ensureDocument(doc: Document): DocumentState | undefined {
  const existing = documents.get(doc)
  if (existing !== undefined) return existing
  const view = doc.defaultView
  if (view === null) return undefined
  const state: DocumentState = {
    view,
    entries: new Set(),
    listener: (event: KeyboardEvent) => handleKeyDown(state, doc, event),
  }
  view.addEventListener('keydown', state.listener, true)
  documents.set(doc, state)
  return state
}

export function registerVimEditor(controller: IVimEditorController): { dispose(): void } {
  const doc = controller.editor.getContainerDomNode().ownerDocument
  const state = ensureDocument(doc)
  if (state === undefined) return { dispose: () => undefined }
  const entry: VimEditorEntry = { controller, sequence: nextSequence++ }
  state.entries.add(entry)
  return {
    dispose: () => {
      if (!state.entries.delete(entry)) return
      if (state.entries.size > 0) return
      state.view.removeEventListener('keydown', state.listener, true)
      documents.delete(doc)
    },
  }
}

/** Test-only: drop every registered document and listener. */
export function __resetVimEditorRegistryForTests(): void {
  for (const [doc, state] of documents) {
    state.view.removeEventListener('keydown', state.listener, true)
    documents.delete(doc)
  }
  nextSequence = 1
}

/** Test-only: number of live controllers for a document. */
export function __getVimEditorCountForTests(doc: Document): number {
  return documents.get(doc)?.entries.size ?? 0
}
