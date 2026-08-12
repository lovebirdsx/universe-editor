/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  DocumentMirrorTracking — module-level bridge from MainThread* code to the
 *  DocumentSyncContribution's open/change/close mirror pipeline.
 *
 *  The contribution (created by DI at AfterRestore) registers itself here;
 *  `MainThreadEditor.$openTextDocument` attaches programmatically created models
 *  through it, so a document opened via the extension API joins the exact same
 *  sync pipeline (language activation → full-text open → incremental deltas) as
 *  one the user opened. Kept module-level like the sibling PendingDocumentSync:
 *  importing the contribution class from services/ would close a circular
 *  import through ExtensionHostClientService.
 *--------------------------------------------------------------------------------------------*/

import type { URI } from '@universe-editor/platform'
import type { monaco } from '../../workbench/editor/monaco/MonacoLoader.js'

export interface IDocumentMirrorTracker {
  /** Attach `model` to the mirror pipeline unless already tracked. False once disposed. */
  trackModel(resource: URI, model: monaco.editor.ITextModel): boolean
  /** Whether the document for `resource` is already mirrored. */
  isTracked(resource: URI): boolean
  /**
   * Resolve once the document's `$acceptDocumentOpen` is on the wire — i.e. the
   * host already knows the URI. Resolves false when the open does not land
   * within `timeoutMs` (or the tracker is gone). Lets a did-save notification
   * wait out the async open so it never names a URI the host has not seen (an
   * untitled buffer's Save-As opens the new file document and fires the save
   * notification in the same tick).
   */
  whenOpened(resource: URI, timeoutMs?: number): Promise<boolean>
}

class DocumentMirrorTrackingImpl {
  private _tracker: IDocumentMirrorTracker | undefined

  register(tracker: IDocumentMirrorTracker): void {
    this._tracker = tracker
  }

  unregister(tracker: IDocumentMirrorTracker): void {
    if (this._tracker === tracker) this._tracker = undefined
  }

  trackModel(resource: URI, model: monaco.editor.ITextModel): boolean {
    return this._tracker?.trackModel(resource, model) ?? false
  }

  isTracked(resource: URI): boolean {
    return this._tracker?.isTracked(resource) ?? false
  }

  whenOpened(resource: URI, timeoutMs?: number): Promise<boolean> {
    return this._tracker?.whenOpened(resource, timeoutMs) ?? Promise.resolve(false)
  }
}

export const DocumentMirrorTracking = new DocumentMirrorTrackingImpl()
