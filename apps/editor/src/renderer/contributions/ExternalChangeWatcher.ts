/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ExternalChangeWatcher — bridge between IFileWatcherService events and the
 *  FileEditorInputs currently open in any editor group. Each batch is fanned
 *  out to matching inputs which decide (clean → silent reload, dirty → prompt)
 *  via `checkExternalChange`. Open diff editors viewing a changed file have
 *  their working-tree side refreshed in place (e.g. after an SCM discard).
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IDialogService,
  IEditorGroupsService,
  IFileService,
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
import { DiffEditorInput } from '../services/editor/DiffEditorInput.js'
import { isDescendant } from '../services/explorer/explorerTreeUtils.js'

export class ExternalChangeWatcher extends Disposable implements IWorkbenchContribution {
  private readonly _logger: ILogger

  constructor(
    @IFileWatcherService watcher: IFileWatcherService,
    @IEditorGroupsService private readonly _groups: IEditorGroupsService,
    @IDialogService private readonly _dialog: IDialogService,
    @IFileService private readonly _fileService: IFileService,
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

    // A 'deleted' event is frequently just an atomic rewrite (e.g. `git
    // checkout` rewriting the file). Confirm the path is really gone before
    // closing — survivors are treated as content changes so the open editor
    // reloads its content instead of being closed.
    if (deletedResources.length > 0) {
      const trulyDeleted: URI[] = []
      for (const u of deletedResources) {
        if (await this._exists(u)) {
          changedKeys.add(u.toString())
        } else {
          trulyDeleted.push(u)
        }
      }
      if (trulyDeleted.length > 0) this._closeDeletedEditors(trulyDeleted)
    }

    if (changedKeys.size === 0) return

    await this._reloadChangedFileEditors(changedKeys)
    await this._refreshChangedDiffEditors(changedKeys)
  }

  private async _exists(resource: URI): Promise<boolean> {
    try {
      await this._fileService.stat(resource)
      return true
    } catch {
      return false
    }
  }

  private async _reloadChangedFileEditors(changedKeys: Set<string>): Promise<void> {
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

  /**
   * Re-read the working-tree side of any open diff editor whose file changed.
   * The original (HEAD) side is a snapshot that a discard does not affect, so
   * only the modified side is refreshed — after a discard it equals HEAD and the
   * diff collapses to empty.
   */
  private async _refreshChangedDiffEditors(changedKeys: Set<string>): Promise<void> {
    const byUri = new Map<string, DiffEditorInput[]>()
    for (const group of this._groups.groups) {
      for (const editor of group.editors) {
        if (!(editor instanceof DiffEditorInput)) continue
        const key = editor.originalUri.toString()
        if (!changedKeys.has(key)) continue
        const list = byUri.get(key) ?? []
        list.push(editor)
        byUri.set(key, list)
      }
    }
    for (const inputs of byUri.values()) {
      const uri = inputs[0]!.originalUri
      let text: string
      try {
        text = await this._fileService.readFileText(uri)
      } catch {
        // Gone from disk — the deletion path closes it; nothing to refresh.
        continue
      }
      for (const input of inputs) input.update(input.originalContent, text)
    }
  }

  private _closeDeletedEditors(deletedResources: readonly URI[]): void {
    for (const group of this._groups.groups) {
      for (const editor of [...group.editors]) {
        let target: URI | undefined
        if (editor instanceof FileEditorInput) {
          target = editor.resource
        } else if (editor instanceof DiffEditorInput) {
          target = editor.originalUri
        }
        if (!target) continue
        const resource = target
        if (
          deletedResources.some(
            (deleted) => isDescendant(deleted, resource) && deleted.scheme === resource.scheme,
          )
        ) {
          group.closeEditor(editor)
          this._logger.info(`closeDeletedEditor ${resource.toString()} group=${group.id}`)
        }
      }
    }
  }
}
