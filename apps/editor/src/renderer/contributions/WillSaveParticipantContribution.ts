/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Bridges the workbench save flow to the trusted extension host's
 *  `workspace.onWillSaveTextDocument`: on every file save, asks the host to run
 *  its will-save listeners and applies the text edits they contribute (e.g.
 *  ESLint fix-all-on-save) to the model before it is written to disk.
 *
 *  Registers a single participant onto the SaveParticipant static registry that
 *  FileEditorInput.save() awaits. The round trip is a WAITING RPC (unlike the
 *  fire-and-forget document mirror in DocumentSyncContribution), so the host's
 *  mirror must be flushed to the just-typed text first — otherwise a participant
 *  lints stale content.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, type IWorkbenchContribution } from '@universe-editor/platform'
import { type monaco } from '../workbench/editor/monaco/MonacoLoader.js'
import { IExtensionHostClientService } from '../services/extensions/ExtensionHostClientService.js'
import { PendingDocumentSync } from '../services/extensions/PendingDocumentSync.js'
import { SaveParticipant, type SaveReason } from '../services/extensions/SaveParticipant.js'
import { textEditsToMonaco } from '../services/languageFeatures/typescript/lspMonacoConvert.js'

export class WillSaveParticipantContribution extends Disposable implements IWorkbenchContribution {
  constructor(@IExtensionHostClientService private readonly _client: IExtensionHostClientService) {
    super()
    this._register(SaveParticipant.register((model, reason) => this._participate(model, reason)))
  }

  private async _participate(model: monaco.editor.ITextModel, reason: SaveReason): Promise<void> {
    const documents = this._client.getDocuments()
    if (!documents) return

    // Push the current (possibly debounced) buffer to the host first, so
    // participants lint the text about to be saved, not the last synced version.
    await PendingDocumentSync.flush(model.uri.toString())
    if (model.isDisposed()) return

    const edits = await documents.$provideWillSaveEdits(model.uri, reason)
    if (edits.length === 0 || model.isDisposed()) return

    const ops = textEditsToMonaco(edits).map<monaco.editor.IIdentifiedSingleEditOperation>((e) => ({
      range: e.range,
      text: e.text,
      forceMoveMarkers: true,
    }))
    model.pushEditOperations(null, ops, () => null)
  }
}
