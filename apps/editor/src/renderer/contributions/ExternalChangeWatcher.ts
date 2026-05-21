/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ExternalChangeWatcher — bridge between IFileWatcherService events and the
 *  FileEditorInputs currently open in any editor group. Each batch is fanned
 *  out to matching inputs which decide (clean → silent reload, dirty → prompt)
 *  via `checkExternalChange`.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IDialogService,
  IEditorGroupsService,
  IFileWatcherService,
  ILoggerService,
  NullLogger,
  URI,
  type IFileChangeEvent,
  type ILogger,
  type ILoggerService as ILoggerServiceType,
  type IWorkbenchContribution,
} from '@universe-editor/platform'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import { isDescendant } from '../services/explorer/explorerTreeUtils.js'

export class ExternalChangeWatcher extends Disposable implements IWorkbenchContribution {
  private readonly _logger: ILogger

  constructor(
    @IFileWatcherService watcher: IFileWatcherService,
    @IEditorGroupsService private readonly _groups: IEditorGroupsService,
    @IDialogService private readonly _dialog: IDialogService,
    @ILoggerService loggerService: ILoggerServiceType,
  ) {
    super()
    this._logger =
      loggerService?.createLogger({ id: 'externalChange', name: 'External Change' }) ??
      new NullLogger()
    this._register(
      watcher.onDidChangeFiles((events) => {
        // Don't await — events run concurrently per group.
        void this._handle(events)
      }),
    )
  }

  private async _handle(events: readonly IFileChangeEvent[]): Promise<void> {
    if (events.length === 0) return
    this._logger.debug(`handleExternalChanges events=${events.length}`)
    const deletedResources: URI[] = []
    const changedKeys = new Set<string>()
    for (const ev of events) {
      const u = URI.revive(ev.resource as Parameters<typeof URI.revive>[0])
      if (!u) continue
      if (ev.type === 'deleted') {
        deletedResources.push(u)
      } else {
        changedKeys.add(u.toString())
      }
    }
    if (deletedResources.length > 0) {
      this._closeDeletedEditors(deletedResources)
    }
    if (changedKeys.size === 0) return

    const matches: FileEditorInput[] = []
    for (const group of this._groups.groups) {
      for (const editor of group.editors) {
        if (editor instanceof FileEditorInput && changedKeys.has(editor.resource.toString())) {
          matches.push(editor)
        }
      }
    }
    if (matches.length === 0) return
    this._logger.info(`externalChanges matchedEditors=${matches.length}`)

    // De-dup by URI: a file can be open in multiple groups, but we only want
    // to prompt once per resource.
    const seen = new Set<string>()
    for (const input of matches) {
      const key = input.resource.toString()
      if (seen.has(key)) continue
      seen.add(key)
      try {
        await input.checkExternalChange(this._dialog)
      } catch (err) {
        // Best-effort: a failure on one input must not stall the others.
        this._logger.warn(`externalChange check failed ${key}`, err)
      }
    }
  }

  private _closeDeletedEditors(deletedResources: readonly URI[]): void {
    for (const group of this._groups.groups) {
      for (const editor of [...group.editors]) {
        if (!(editor instanceof FileEditorInput)) continue
        if (
          deletedResources.some(
            (deleted) =>
              isDescendant(deleted, editor.resource) && deleted.scheme === editor.resource.scheme,
          )
        ) {
          group.closeEditor(editor)
          this._logger.info(`closeDeletedEditor ${editor.resource.toString()} group=${group.id}`)
        }
      }
    }
  }
}
