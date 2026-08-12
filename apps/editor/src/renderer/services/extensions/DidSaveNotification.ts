/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  DidSaveNotification — a static registry that lets code outside the editor
 *  input (notably the extension host, via `workspace.onDidSaveTextDocument`)
 *  observe a document right after it was written to disk.
 *
 *  FileEditorInput.save() has no DI access to the extension host client, so this
 *  mirrors the SaveParticipant pattern: a module-level singleton the input
 *  calls, and a workbench contribution registers the actual listener onto.
 *
 *  Wired save paths: FileEditorInput.save() (in-place file saves, which also
 *  covers the Markdown/Html previews — they delegate to their source
 *  FileEditorInput), SaveFileAsAction (Save-As of a file or untitled buffer;
 *  the notification names the picked file URI), and MergeEditorInput.save().
 *  SchemaViewer is read-only, so no save path remains TODO. The notification
 *  pipeline itself (DidSaveNotificationContribution) waits for the document
 *  mirror's open push before pushing, so a Save-As that opens a brand-new file
 *  document never races the open it depends on.
 *--------------------------------------------------------------------------------------------*/

import type { URI } from '@universe-editor/platform'

export type DidSaveListenerFn = (uri: URI) => void

class DidSaveNotificationImpl {
  private readonly _listeners = new Set<DidSaveListenerFn>()

  register(listener: DidSaveListenerFn): { dispose: () => void } {
    this._listeners.add(listener)
    return { dispose: () => this._listeners.delete(listener) }
  }

  /** Notify every listener. Never throws — a listener failure is logged and
   *  skipped so the save flow is never disturbed after the fact. */
  notify(uri: URI): void {
    if (this._listeners.size === 0) return
    for (const listener of this._listeners) {
      try {
        listener(uri)
      } catch (err) {
        console.error('[did-save-notification] listener failed:', err)
      }
    }
  }
}

export const DidSaveNotification = new DidSaveNotificationImpl()
