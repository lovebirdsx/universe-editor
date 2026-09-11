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
  INotificationService,
  IUriIdentityService,
  IUserDataFilesService,
  NullLogger,
  Severity,
  URI,
  localize,
  type IEditorGroup,
  type IDisposable,
  type IFileChangeEvent,
  type ILogger,
  type ILoggerService as ILoggerServiceType,
  type IWorkbenchContribution,
  type UserDataFile,
} from '@universe-editor/platform'
import { FileEditorInput } from '../services/editor/FileEditorInput.js'
import { DiffEditorInput } from '../services/editor/DiffEditorInput.js'
import { MarkdownPreviewInput } from '../services/editor/MarkdownPreviewInput.js'
import { MonacoModelRegistry } from '../workbench/editor/monaco/MonacoModelRegistry.js'
import { applyMinimalTextEdit } from '../services/editor/minimalModelEdit.js'
import { splitLeadingBom } from '../services/editor/leadingBom.js'
import { isDescendant } from '../services/explorer/explorerTreeUtils.js'
import { readForExternalReload } from '../services/files/externalReload.js'
import { IOutOfWorkspaceWatchService } from '../services/files/outOfWorkspaceWatchService.js'
import { basenameOfResource } from '../workbench/files/resourceInfo.js'

export class ExternalChangeWatcher extends Disposable implements IWorkbenchContribution {
  private readonly _logger: ILogger
  private readonly _groupDisposables = new Map<number, IDisposable>()
  private _watchUpdatePending = false
  private _watchHandle: IDisposable | undefined
  /**
   * Comparison keys already reported as too large to keep reloading. Grows with the
   * number of distinct oversized files anyone opens — a handful at most — and is
   * never pruned on purpose: the alternative is one toast per change batch for as
   * long as the file keeps being written.
   */
  private readonly _tooLargeNotified = new Set<string>()

  constructor(
    @IFileWatcherService private readonly _watcher: IFileWatcherService,
    @IOutOfWorkspaceWatchService
    private readonly _outOfWorkspaceWatch: IOutOfWorkspaceWatchService,
    @IEditorGroupsService private readonly _groups: IEditorGroupsService,
    @IDialogService private readonly _dialog: IDialogService,
    @IFileService private readonly _fileService: IFileService,
    @ILoggerService loggerService: ILoggerServiceType,
    @IUserDataFilesService private readonly _userData: IUserDataFilesService,
    @IUriIdentityService private readonly _uriIdentity: IUriIdentityService,
    @INotificationService private readonly _notifications: INotificationService,
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
    this._updateExtraWatches()
  }

  override dispose(): void {
    this._watchHandle?.dispose()
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
      this._updateExtraWatches()
    }, 0)
  }

  private _updateExtraWatches(): void {
    const uris: URI[] = []
    for (const group of this._groups.groups) {
      for (const editor of group.editors) {
        if (editor instanceof FileEditorInput) {
          uris.push(editor.resource)
        } else if (editor instanceof MarkdownPreviewInput) {
          // A pure-preview (toggle or link-reached) has no FileEditorInput to
          // pull the source into the watch set, so watch its source directly —
          // otherwise an out-of-workspace preview never sees external edits.
          uris.push(editor.sourceUri)
        }
      }
    }
    this._watchHandle?.dispose()
    this._watchHandle = this._outOfWorkspaceWatch.watch(uris)
  }

  private async _handleUserDataChange(file: UserDataFile): Promise<void> {
    const uri = await this._userData.getFileUri(file)
    if (!uri) return
    // force: a same-content atomic rewrite can leave mtime unchanged at coarse
    // filesystem granularity, so reconcile against disk content directly.
    await this._reloadChangedFileEditors(new Set([this._uriIdentity.getComparisonKey(uri)]), true)
  }

  /**
   * Resources of everything currently open that reacts to disk changes:
   * file editors, diff editors (original side), and markdown preview sources.
   * Used to pre-filter watcher batches so we never touch the filesystem for a
   * change that can't affect any open editor.
   */
  private _collectWatchedResources(): { keys: Set<string>; resources: URI[] } {
    const keys = new Set<string>()
    const resources: URI[] = []
    const add = (uri: URI): void => {
      keys.add(this._uriIdentity.getComparisonKey(uri))
      resources.push(uri)
    }
    for (const group of this._groups.groups) {
      for (const editor of group.editors) {
        if (editor instanceof FileEditorInput) add(editor.resource)
        else if (editor instanceof DiffEditorInput) add(editor.originalUri)
        else if (editor instanceof MarkdownPreviewInput) add(editor.sourceUri)
      }
    }
    return { keys, resources }
  }

  private async _handle(events: readonly IFileChangeEvent[]): Promise<void> {
    if (events.length === 0) return

    // Pre-filter against the open editors before doing any work. Watching a
    // large, high-churn tree (e.g. a game-engine folder that constantly writes
    // and deletes temp files) fires thousands of events per batch; without this
    // gate every deleted event triggered a cross-process `stat`, piling up
    // unbounded pending IPC + stacked _handle calls until the renderer OOMed.
    // A change is relevant only if it matches an open editor, or (for a delete)
    // is an ancestor directory of one — the exact conditions the handlers below
    // act on.
    const watched = this._collectWatchedResources()
    if (watched.resources.length === 0) return

    const deletedResources: URI[] = []
    const changedKeys = new Set<string>()
    for (const ev of events) {
      const u = ev.resource
      if (ev.type === 'deleted') {
        const key = this._uriIdentity.getComparisonKey(u)
        // Relevant if it IS an open editor (atomic-rewrite → reload) or an
        // ancestor of one (directory delete → close descendant tabs).
        if (watched.keys.has(key) || watched.resources.some((r) => isDescendant(u, r))) {
          deletedResources.push(u)
        }
      } else {
        const key = this._uriIdentity.getComparisonKey(u)
        if (watched.keys.has(key)) changedKeys.add(key)
      }
    }
    if (deletedResources.length === 0 && changedKeys.size === 0) return
    this._logger.debug(
      `handleExternalChanges events=${events.length} relevant deleted=${deletedResources.length} changed=${changedKeys.size}`,
    )

    // A 'deleted' event is frequently just an atomic rewrite (e.g. `git
    // checkout` rewriting the file). Confirm the path is really gone before
    // closing — survivors are treated as content changes so the open editor
    // reloads its content instead of being closed.
    if (deletedResources.length > 0) {
      const trulyDeleted: URI[] = []
      for (const u of deletedResources) {
        if (await this._exists(u)) {
          changedKeys.add(this._uriIdentity.getComparisonKey(u))
        } else {
          trulyDeleted.push(u)
        }
      }
      if (trulyDeleted.length > 0) this._closeDeletedEditors(trulyDeleted)
    }

    if (changedKeys.size === 0) return

    // Collected per batch (this runs concurrently for overlapping batches) and
    // reported after all three reconcile passes, so a file refused by more than one
    // of them still produces a single notice.
    const skipped = new Map<string, URI>()
    const handled = await this._reloadChangedFileEditors(changedKeys, false, skipped)
    await this._reconcilePreviewModels(changedKeys, handled, skipped)
    await this._refreshChangedDiffEditors(changedKeys, handled, skipped)
    this._notifyTooLarge(skipped)
  }

  /**
   * Say it once per file. A buffer that silently stops tracking disk is a data-loss
   * trap — the user sees stale content, edits it and saves over someone else's
   * write — so the refusal is never silent, but it is also never repeated: the file
   * can keep changing every second for minutes.
   */
  private _notifyTooLarge(skipped: ReadonlyMap<string, URI>): void {
    for (const [key, uri] of skipped) {
      if (this._tooLargeNotified.has(key)) continue
      this._tooLargeNotified.add(key)
      this._logger.info(`externalChange tooLargeToReload ${uri.toString()}`)
      this._notifications.notify({
        severity: Severity.Warning,
        message: localize(
          'editor.externalReloadTooLarge',
          '"{name}" is too large to keep in sync with changes on disk. Reopen it to load the latest content.',
          { name: basenameOfResource(uri) },
        ),
      })
    }
  }

  private async _exists(resource: URI): Promise<boolean> {
    try {
      await this._fileService.stat(resource)
      return true
    } catch {
      return false
    }
  }

  private async _reloadChangedFileEditors(
    changedKeys: Set<string>,
    force = false,
    skipped?: Map<string, URI>,
  ): Promise<Set<string>> {
    const matches: FileEditorInput[] = []
    for (const group of this._groups.groups) {
      for (const editor of group.editors) {
        if (
          editor instanceof FileEditorInput &&
          changedKeys.has(this._uriIdentity.getComparisonKey(editor.resource))
        ) {
          matches.push(editor)
        }
      }
    }
    const handled = new Set<string>()
    if (matches.length === 0) return handled
    this._logger.info(`externalChanges matchedEditors=${matches.length}`)

    // De-dup by URI: a file can be open in multiple groups, but we only want
    // to prompt once per resource.
    const seen = new Set<string>()
    for (const input of matches) {
      const key = this._uriIdentity.getComparisonKey(input.resource)
      handled.add(key)
      if (seen.has(key)) continue
      seen.add(key)
      try {
        if ((await input.checkExternalChange(this._dialog, force)) === 'too-large') {
          skipped?.set(key, input.resource)
        }
      } catch (err) {
        // Best-effort: a failure on one input must not stall the others.
        this._logger.warn(`externalChange check failed ${key}`, err)
      }
    }
    return handled
  }

  /**
   * Reconcile the markdown previews reached WITHOUT their source open as a
   * FileEditorInput in a group — so nothing else pulls external disk edits into
   * the model they render:
   *   - toggle mode (Ctrl+Shift+V): the preview holds the detached source
   *     FileEditorInput. Delegate to its dirty-aware `checkExternalChange` (its
   *     model is shared with the preview, so the reload fires onDidChangeContent).
   *   - link-reached: no source input at all; the preview acquired a clean disk
   *     model. Reconcile it directly with a minimal edit (never dirty — the
   *     preview is read-only), which fires the onDidChangeContent it subscribes to.
   * Keys already handled by `_reloadChangedFileEditors` (source open in a group,
   * model shared) are skipped.
   */
  private async _reconcilePreviewModels(
    changedKeys: Set<string>,
    handled: Set<string>,
    skipped: Map<string, URI>,
  ): Promise<void> {
    const heldSources: FileEditorInput[] = []
    const orphanUris = new Map<string, URI>()
    for (const group of this._groups.groups) {
      for (const editor of group.editors) {
        if (!(editor instanceof MarkdownPreviewInput)) continue
        const key = this._uriIdentity.getComparisonKey(editor.sourceUri)
        if (!changedKeys.has(key) || handled.has(key)) continue
        const source = editor.sourceInput
        if (source) {
          heldSources.push(source)
        } else {
          orphanUris.set(key, editor.sourceUri)
        }
      }
    }

    const seen = new Set<string>()
    for (const source of heldSources) {
      const key = this._uriIdentity.getComparisonKey(source.resource)
      if (seen.has(key)) continue
      seen.add(key)
      try {
        if ((await source.checkExternalChange(this._dialog)) === 'too-large') {
          skipped.set(key, source.resource)
        }
      } catch (err) {
        this._logger.warn(`preview source reconcile failed ${key}`, err)
      }
    }

    for (const [key, uri] of orphanUris) {
      const model = MonacoModelRegistry.peek(uri)
      if (!model || model.isDisposed()) continue
      try {
        const read = await readForExternalReload(this._fileService, uri)
        if (!read.ok) {
          if (read.reason === 'too-large') skipped.set(key, uri)
          continue
        }
        // Re-check after the await: closing the preview releases the model
        // inside this window, and editing a disposed model throws.
        if (model.isDisposed()) continue
        applyMinimalTextEdit(model, read.text)
      } catch (err) {
        this._logger.warn(`preview reconcile failed ${key}`, err)
      }
    }
  }

  /**
   * Re-read the working-tree side of any open diff editor whose file changed.
   * The original (HEAD) side is a snapshot that a discard does not affect, so
   * only the modified side is refreshed — after a discard it equals HEAD and the
   * diff collapses to empty.
   *
   * An editable diff's modified side IS the shared buffer, so it reconciles like
   * a file editor: a key already `handled` by `_reloadChangedFileEditors` means
   * the same-file FileEditor already reconciled the model — mirror it. Otherwise
   * read disk and, when the buffer is clean and differs, reconcile with a minimal
   * edit + markClean; a dirty buffer keeps the user's in-progress edits.
   */
  private async _refreshChangedDiffEditors(
    changedKeys: Set<string>,
    handled: Set<string>,
    skipped: Map<string, URI>,
  ): Promise<void> {
    const byUri = new Map<string, DiffEditorInput[]>()
    for (const group of this._groups.groups) {
      for (const editor of group.editors) {
        // Snapshot diffs (commit-to-commit, depot revisions) are frozen — a
        // working-tree change must not rewrite their right side.
        if (!(editor instanceof DiffEditorInput) || !editor.liveModified) continue
        const key = this._uriIdentity.getComparisonKey(editor.originalUri)
        if (!changedKeys.has(key)) continue
        const list = byUri.get(key) ?? []
        list.push(editor)
        byUri.set(key, list)
      }
    }
    for (const inputs of byUri.values()) {
      const uri = inputs[0]!.originalUri
      const key = this._uriIdentity.getComparisonKey(uri)
      const liveModel = MonacoModelRegistry.peek(uri)
      const model = liveModel && !liveModel.isDisposed() ? liveModel : undefined

      if (inputs[0]!.modifiedEditable) {
        if (!handled.has(key)) {
          const read = await readForExternalReload(this._fileService, uri)
          if (!read.ok) {
            // Too large → leave the diff as it is and say so once. Unreadable →
            // gone from disk; the deletion path closes it, nothing to refresh.
            if (read.reason === 'too-large') skipped.set(key, uri)
            continue
          }
          const diskText = read.text
          // Re-check after the await: closing the tab releases the shared model
          // inside this window, and both reads below would throw on a disposed
          // one. A disposed model means no editor still holds this URI (the
          // registry is refcounted), so there is nothing left to mirror into.
          if (model?.isDisposed()) continue
          const content = splitLeadingBom(diskText)
          if (model && !inputs[0]!.isDirty && model.getValue() !== content.text) {
            applyMinimalTextEdit(model, content.text)
            MonacoModelRegistry.markModelClean(model)
          }
          if (!model) {
            for (const input of inputs) input.update(input.originalContent, content.text)
            continue
          }
        }
        // Mirror the live buffer into the input: after a handled FileEditor
        // reconcile the model is fresh, and a dirty buffer wins over disk.
        if (model) {
          const text = model.getValue()
          for (const input of inputs) input.update(input.originalContent, text)
        }
        continue
      }

      // Non-editable liveModified diff (defensive): existing buffer-wins path.
      let text: string
      if (model) {
        text = model.getValue()
      } else {
        const read = await readForExternalReload(this._fileService, uri)
        if (!read.ok) {
          if (read.reason === 'too-large') skipped.set(key, uri)
          continue
        }
        text = read.text
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
