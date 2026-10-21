/*---------------------------------------------------------------------------------------------
 *  Workbench document registry.
 *
 *  Editor groups can now render into auxiliary windows. DOM-derived helpers that
 *  live outside DI (`editorFocus`, focus reconcile, drag cleanup) still need to
 *  know which documents make up the workbench and which one is focused, so the
 *  window registry publishes that here as a tiny module-level view.
 *--------------------------------------------------------------------------------------------*/

import {
  Emitter,
  markAsSingleton,
  toDisposable,
  type Event,
  type IDisposable,
} from '@universe-editor/platform'

const documents = new Set<Document>()
let activeDocument: Document | undefined
const onDidAddDocumentEmitter = new Emitter<Document>()
const onDidRemoveDocumentEmitter = new Emitter<Document>()

/** Fires for every registered workbench document (main first, then aux). */
export const onDidAddWorkbenchDocument: Event<Document> = onDidAddDocumentEmitter.event
export const onDidRemoveWorkbenchDocument: Event<Document> = onDidRemoveDocumentEmitter.event

export function registerWorkbenchDocument(doc: Document): IDisposable {
  const added = !documents.has(doc)
  documents.add(doc)
  if (documents.size === 1) activeDocument = doc
  if (added) onDidAddDocumentEmitter.fire(doc)
  // The registration outlives React unmount (windows close with the service),
  // so tell the leak tracker it is intentionally rooted at module scope.
  return markAsSingleton(
    toDisposable(() => {
      // 先注销再广播：监听方（焦点跟踪/派生键）要在一致的注册表状态下重算，
      // 否则会读到正在销毁的文档仍是 active。
      documents.delete(doc)
      if (activeDocument === doc) {
        const first = documents.values().next()
        activeDocument = first.done ? undefined : first.value
      }
      onDidRemoveDocumentEmitter.fire(doc)
    }),
  )
}

export function setActiveWorkbenchDocument(doc: Document): void {
  if (documents.has(doc)) activeDocument = doc
}

/** Focused workbench document, falling back to the main document. */
export function getActiveWorkbenchDocument(): Document {
  return activeDocument ?? document
}

export function getWorkbenchDocuments(): readonly Document[] {
  return [...documents]
}

/** Find the workbench document that owns `node` (used for anchor-based overlays). */
export function getDocumentForNode(node: Node | null | undefined): Document {
  return node?.ownerDocument ?? getActiveWorkbenchDocument()
}
