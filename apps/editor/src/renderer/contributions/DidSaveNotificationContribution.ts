/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Bridges the workbench save flow to the extension host's
 *  `workspace.onDidSaveTextDocument`: after a save has written the file, waits
 *  for the document mirror's open push, flushes any debounced change (a
 *  will-save participant may have edited the model milliseconds before the
 *  write) and then pushes the did-save notification, so host listeners read the
 *  text that is actually on disk. Fire-and-forget: the save is already done, a
 *  push failure only costs the host one event.
 *
 *  The mirror wait matters for Save-As: an untitled buffer's save writes the
 *  file and fires the notification in the same tick, while the replacement
 *  FileEditorInput's model mounts (and its `$acceptDocumentOpen` lands) a few
 *  microtasks later. The host drops saves for URIs it has never seen open, so
 *  the notification must not overtake the open. An already-mirrored save
 *  (in-place FileEditorInput.save()) resolves the wait synchronously.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  ILoggerService,
  type ILogger,
  type IWorkbenchContribution,
  type URI,
} from '@universe-editor/platform'
import { IExtensionHostClientService } from '../services/extensions/ExtensionHostClientService.js'
import { DidSaveNotification } from '../services/extensions/DidSaveNotification.js'
import { PendingDocumentSync } from '../services/extensions/PendingDocumentSync.js'
import { DocumentMirrorTracking } from '../services/extensions/DocumentMirrorTracking.js'
import { MonacoModelRegistry } from '../workbench/editor/monaco/MonacoModelRegistry.js'

export class DidSaveNotificationContribution extends Disposable implements IWorkbenchContribution {
  private readonly _logger: ILogger

  constructor(
    @IExtensionHostClientService private readonly _client: IExtensionHostClientService,
    @ILoggerService loggerService: ILoggerService,
  ) {
    super()
    this._logger = loggerService.createLogger({ id: 'extHostDidSave', name: 'Extension Did Save' })
    this._register(
      DidSaveNotification.register((uri, hint) => void this._notify(uri, hint.expectMirrorOpen)),
    )
  }

  private async _notify(uri: URI, expectMirrorOpen: boolean | undefined): Promise<void> {
    const documents = this._client.getDocuments()
    if (!documents) return
    try {
      if (expectMirrorOpen !== false) {
        const mirrored = await DocumentMirrorTracking.whenOpened(uri)
        if (!mirrored) {
          // The host would drop the save of an unmirrored URI anyway; say why.
          this._logger.warn(
            `did-save for ${uri.toString()} pushed without a mirrored open (mirror absent or timed out)`,
          )
        }
      }
      const model = MonacoModelRegistry.peek(uri)
      if (model) await PendingDocumentSync.flush(model.uri.toString())
      // Push the model's canonical URI when there is one: it is the exact key
      // the open push used (Monaco folds the Windows drive-letter case, the
      // input's resource may not), so the host lookup can never miss on case.
      await documents.$acceptDocumentSave(model ? model.uri : uri.toJSON())
    } catch (err) {
      this._logger.warn(`did-save push failed for ${uri.toString()}: ${(err as Error).message}`)
    }
  }
}
