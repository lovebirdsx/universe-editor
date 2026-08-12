/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Bridges the workbench save flow to the extension host's
 *  `workspace.onDidSaveTextDocument`: after FileEditorInput.save() has written
 *  the file, flushes the debounced document mirror (a will-save participant may
 *  have edited the model milliseconds before the write) and then pushes the
 *  did-save notification, so host listeners read the text that is actually on
 *  disk. Fire-and-forget: the save is already done, a push failure only costs
 *  the host one event.
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
import { MonacoModelRegistry } from '../workbench/editor/monaco/MonacoModelRegistry.js'

export class DidSaveNotificationContribution extends Disposable implements IWorkbenchContribution {
  private readonly _logger: ILogger

  constructor(
    @IExtensionHostClientService private readonly _client: IExtensionHostClientService,
    @ILoggerService loggerService: ILoggerService,
  ) {
    super()
    this._logger = loggerService.createLogger({ id: 'extHostDidSave', name: 'Extension Did Save' })
    this._register(DidSaveNotification.register((uri) => void this._notify(uri)))
  }

  private async _notify(uri: URI): Promise<void> {
    const documents = this._client.getDocuments()
    if (!documents) return
    try {
      const model = MonacoModelRegistry.peek(uri)
      if (model) await PendingDocumentSync.flush(model.uri.toString())
      await documents.$acceptDocumentSave(uri.toJSON())
    } catch (err) {
      this._logger.warn(`did-save push failed for ${uri.toString()}: ${(err as Error).message}`)
    }
  }
}
