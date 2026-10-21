/*---------------------------------------------------------------------------------------------
 *  workbenchDocumentEvents — install a document/window listener once per workbench
 *  document (main first, then every auxiliary window), including documents created
 *  later and detaching them when their window closes.
 *
 *  Contributions that used to attach to the main `window` only (mouse back/forward,
 *  the global drag-and-drop safety net, peek navigation) must cover every document:
 *  an auxiliary window's events never reach the main window's document.
 *--------------------------------------------------------------------------------------------*/

import { DisposableStore, type IDisposable } from '@universe-editor/platform'
import {
  getWorkbenchDocuments,
  onDidAddWorkbenchDocument,
  onDidRemoveWorkbenchDocument,
} from './workbenchDocuments.js'

/**
 * Calls `attach` for each workbench document and keeps the subscription in sync
 * with the registry. If no document is registered yet (bootstrap or a DOM-less
 * test), falls back to the global document so behaviour is unchanged there.
 *
 * Every internal disposable lives in the returned store so the whole tree is
 * owned by whoever registers it (and roots at a singleton in the leak tracker);
 * a bare `toDisposable` here would be reported as a leak even when the caller
 * correctly registers it.
 */
export function installPerWorkbenchDocument(attach: (doc: Document) => IDisposable): IDisposable {
  const store = new DisposableStore()
  const attached = new Map<Document, IDisposable>()
  const add = (doc: Document): void => {
    if (attached.has(doc)) return
    attached.set(doc, store.add(attach(doc)))
  }
  const remove = (doc: Document): void => {
    const subscription = attached.get(doc)
    if (subscription === undefined) return
    attached.delete(doc)
    store.delete(subscription)
  }

  for (const doc of getWorkbenchDocuments()) add(doc)
  if (attached.size === 0 && typeof document !== 'undefined') add(document)

  store.add(onDidAddWorkbenchDocument(add))
  store.add(onDidRemoveWorkbenchDocument(remove))
  return store
}
