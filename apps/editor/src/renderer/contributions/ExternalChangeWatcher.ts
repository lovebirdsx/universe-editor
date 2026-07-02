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
  IUserDataFilesService,
  NullLogger,
  URI,
  type IEditorGroup,
  type IDisposable,
  type IFileChangeEvent,
  type ILogger,
  type ILoggerService as ILoggerServiceType,
  type IWorkbenchContribution,
  type UriComponents,
  type UserDataFile,
} from '@universe-editor/platform'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import { DiffEditorInput } from '../services/editor/DiffEditorInput.js'
import { MonacoModelRegistry } from '../workbench/editor/monaco/MonacoModelRegistry.js'
import { isDescendant } from '../services/explorer/explorerTreeUtils.js'

export class ExternalChangeWatcher extends Disposable implements IWorkbenchContribution {
  private readonly _logger: ILogger
  private readonly _groupDisposables = new Map<number, IDisposable>()
  private _watchUpdatePending = false

  constructor(
    @IFileWatcherService private readonly _watcher: IFileWatcherService,
    @IEditorGroupsService private readonly _groups: IEditorGroupsService,
    @IDialogService private readonly _dialog: IDialogService,
    @IFileService private readonly _fileService: IFileService,
    @ILoggerService loggerService: ILoggerServiceType,
    @IUserDataFilesService private readonly _userData: IUserDataFilesService,
  ) {
    super()
    this._logger =
      loggerService?.createLogger({ id: 'externalChange', name: 'External Change' }) ??
      new NullLogger()
    this._register(
      _watcher.onDidChangeFiles((events) => {
        // Don't await — events run concurrently per group.
        void this._handle(events)
      }),
    )
    // User-data files (settings/keybindings/aiSettings) live outside the
    // workspace, so the parcel watcher never sees them. Bridge their change
    // events here so an open editor on those files reloads too.
    this._register(
      this._userData.onDidChangeFile((change) => {
        void this._handleUserDataChange(change.file)
      }),
    )

    // Track editors opening/closing so we can keep out-of-workspace file
    // watches in sync with what's currently open.
    for (const group of this._groups.groups) {
      this._attachGroup(group)
    }
    this._register(
      this._groups.onDidAddGroup((group) => {
        this._attachGroup(group)
        this._scheduleWatchUpdate()
      }),
    )
    this._register(
      this._groups.onDidRemoveGroup((group) => {
        this._detachGroup(group.id)
        this._scheduleWatchUpdate()
      }),
    )
    void this._updateExtraWatches()
  }

  override dispose(): void {
    this._groupDisposables.clear()
    super.dispose()
  }

  private _attachGroup(group: IEditorGroup): void {
    if (this._groupDisposables.has(group.id)) return
    // _register() parents the disposable with ExternalChangeWatcher so the
    // leak tracker can root through it. _groupDisposables tracks it by group
    // id so _detachGroup can dispose early (the subscription is idempotent).
    const d = this._register(
      group.onDidChangeModel((e) => {
        if (e.kind === 'open' || e.kind === 'close') this._scheduleWatchUpdate()
      }),
    )
    this._groupDisposables.set(group.id, d)
  }

  private _detachGroup(id: number): void {
    const d = this._groupDisposables.get(id)
    if (d) {
      d.dispose()
      this._groupDisposables.delete(id)
    }
  }

  private _scheduleWatchUpdate(): void {
    if (this._watchUpdatePending) return
    this._watchUpdatePending = true
    setTimeout(() => {
      this._watchUpdatePending = false
      void this._updateExtraWatches()
    }, 0)
  }

  private async _updateExtraWatches(): Promise<void> {
    const uris: UriComponents[] = []
    for (const group of this._groups.groups) {
      for (const editor of group.editors) {
        if (editor instanceof FileEditorInput) {
          uris.push(editor.resource.toJSON())
        }
      }
    }
    await this._watcher.watchOutOfWorkspace(uris)
  }

  private async _handleUserDataChange(file: UserDataFile): Promise<void> {
    const components = await this._userData.getFileUri(file)
    if (!components) return
    const uri = URI.revive(components as Parameters<typeof URI.revive>[0])
    if (!uri) return
    // force: a same-content atomic rewrite can leave mtime unchanged at coarse
    // filesystem granularity, so reconcile against disk content directly.
    await this._reloadChangedFileEditors(new Set([uri.toString()]), true)
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

  private async _reloadChangedFileEditors(changedKeys: Set<string>, force = false): Promise<void> {
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
        await input.checkExternalChange(this._dialog, force)
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
   *
   * A file open in an editor with *unsaved* edits is the exception: its live
   * buffer, not the (stale) disk text, is the modified side's truth — refreshing
   * from disk would clobber the user's in-progress edit that
   * DiffLiveContentSyncContribution mirrors into the diff. When a live model
   * exists we push its value (which equals disk for a clean file, incl. after an
   * SCM discard that reverts the model); only when no model is loaded do we fall
   * back to reading disk.
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
      // The editor buffer wins over disk when the file is open: it may hold
      // unsaved edits the stale fs event must not clobber.
      const liveModel = MonacoModelRegistry.peek(uri)
      let text: string
      if (liveModel && !liveModel.isDisposed()) {
        text = liveModel.getValue()
      } else {
        try {
          text = await this._fileService.readFileText(uri)
        } catch {
          // Gone from disk — the deletion path closes it; nothing to refresh.
          continue
        }
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
