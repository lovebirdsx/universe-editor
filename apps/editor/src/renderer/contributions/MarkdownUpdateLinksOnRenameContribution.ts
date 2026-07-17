/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Update markdown links on file move/rename (VSCode's "Update links on file
 *  move" feature). When a file/folder is renamed or moved in the Explorer, ask
 *  the markdown plugin for the edits that fix every link affected — links across
 *  the workspace pointing at the moved files, plus the moved markdown files' own
 *  relative links — and apply them.
 *
 *  Setting `markdown.updateLinksOnFileMove.enabled`:
 *    - never  : disabled.
 *    - prompt : ask before applying (Yes / No / Always / Never). Default.
 *    - always : apply silently.
 *
 *  The edits come from the plugin (its language service owns the cross-file link
 *  index); we only capture the rename event, gate on the setting, and apply the
 *  resulting WorkspaceEdit via the same FileBulkEditService the cross-file rename
 *  path uses. Renames are debounced so a burst (multi-select move) is one prompt.
 *--------------------------------------------------------------------------------------------*/

import {
  ConfigurationTarget,
  Disposable,
  IConfigurationService,
  IDialogService,
  IInstantiationService,
  type ILogger,
  ILoggerService,
  type IWorkbenchContribution,
  createNamedLogger,
} from '@universe-editor/platform'
import type { WorkspaceEdit } from 'vscode-languageserver-types'
import {
  IExplorerTreeService,
  type ExplorerTreeService,
  type IFileRenameOperation,
} from '../services/explorer/ExplorerTreeService.js'
import { IExtensionHostClientService } from '../services/extensions/ExtensionHostClientService.js'
import { FileBulkEditService } from '../services/languageFeatures/typescript/fileBulkEditService.js'
import { workspaceEditToMonaco } from '../services/languageFeatures/typescript/lspMonacoConvert.js'
import { MonacoLoader } from '../workbench/editor/monaco/MonacoLoader.js'

const CONFIG_KEY = 'markdown.updateLinksOnFileMove.enabled'
type UpdateSetting = 'never' | 'prompt' | 'always'

const GET_RENAME_FILE_EDITS_COMMAND = 'markdown.getRenameFileEdits'
const DID_CHANGE_FILES_COMMAND = 'markdown.didChangeFiles'

/** Merge a burst of renames (multi-select move) into one prompt. */
const DEBOUNCE_MS = 50

/**
 * Retry `getRenameFileEdits` when it comes back empty. Right after a move, an
 * empty result is almost always a not-ready race: on a cold host (notably slow
 * CI) the plugin's workspace file scan (gated `workspace.fs`) or the host itself
 * may not be ready at flush time, so the language service finds no referrers and
 * returns no edits — and this flush is fire-once, so the links would never get
 * updated. A move that genuinely touches no links just spends these few
 * best-effort background attempts and then stops.
 */
const EMPTY_EDIT_RETRIES = 5
const EMPTY_EDIT_RETRY_DELAY_MS = 300

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Extensions whose move should trigger a link update (markdown + linkable assets). */
const TRIGGER_EXTENSIONS = new Set([
  'md',
  'markdown',
  'jpg',
  'jpe',
  'jpeg',
  'png',
  'bmp',
  'gif',
  'ico',
  'webp',
  'avif',
  'tiff',
  'svg',
  'mp4',
])

/** Cap the file list shown in the confirm prompt (VSCode uses 10). */
const MAX_CONFIRM_FILES = 10

interface RenameDto {
  readonly oldUri: string
  readonly newUri: string
}

function extensionOf(path: string): string {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  const name = slash === -1 ? path : path.slice(slash + 1)
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/** A rename participates when it's a directory or a markdown/asset file. */
function participates(op: IFileRenameOperation): boolean {
  if (op.isDirectory) return true
  return TRIGGER_EXTENSIONS.has(extensionOf(op.newUri.path))
}

/** The set of files a WorkspaceEdit touches, for the confirm dialog. */
function affectedResources(edit: WorkspaceEdit): string[] {
  const uris = new Set<string>()
  if (edit.documentChanges) {
    for (const change of edit.documentChanges) {
      if ('textDocument' in change) uris.add(change.textDocument.uri)
    }
  }
  if (edit.changes) {
    for (const uri of Object.keys(edit.changes)) uris.add(uri)
  }
  return [...uris]
}

function basename(uri: string): string {
  try {
    const path = new URL(uri).pathname
    const slash = path.lastIndexOf('/')
    return decodeURIComponent(slash === -1 ? path : path.slice(slash + 1))
  } catch {
    const slash = Math.max(uri.lastIndexOf('/'), uri.lastIndexOf('\\'))
    return slash === -1 ? uri : uri.slice(slash + 1)
  }
}

export class MarkdownUpdateLinksOnRenameContribution
  extends Disposable
  implements IWorkbenchContribution
{
  private readonly _logger: ILogger
  private readonly _bulkEdit: FileBulkEditService
  private _pending: RenameDto[] = []
  private _timer: ReturnType<typeof setTimeout> | undefined

  constructor(
    @IExplorerTreeService explorer: ExplorerTreeService,
    @IExtensionHostClientService private readonly _client: IExtensionHostClientService,
    @IConfigurationService private readonly _config: IConfigurationService,
    @IDialogService private readonly _dialog: IDialogService,
    @IInstantiationService instantiation: IInstantiationService,
    @ILoggerService loggerService: ILoggerService,
  ) {
    super()
    this._logger = createNamedLogger(loggerService, {
      id: 'markdownUpdateLinks',
      name: 'Markdown Update Links',
    })
    this._bulkEdit = instantiation.createInstance(FileBulkEditService)

    this._register(explorer.onDidRunFileOperation((ops) => this._onRenames(ops)))
    this._register({ dispose: () => this._timer !== undefined && clearTimeout(this._timer) })
  }

  private _setting(): UpdateSetting {
    return this._config.get<UpdateSetting>(CONFIG_KEY) ?? 'prompt'
  }

  private _onRenames(ops: readonly IFileRenameOperation[]): void {
    if (this._setting() === 'never') return
    const relevant = ops.filter(participates)
    if (relevant.length === 0) return

    for (const op of relevant) {
      this._pending.push({ oldUri: op.oldUri.toString(), newUri: op.newUri.toString() })
    }
    if (this._timer !== undefined) clearTimeout(this._timer)
    this._timer = setTimeout(() => {
      this._timer = undefined
      void this._flush()
    }, DEBOUNCE_MS)
  }

  private async _flush(): Promise<void> {
    const renames = this._pending
    this._pending = []
    if (renames.length === 0) return

    // Re-check: the setting may have flipped to `never` between event and flush.
    if (this._setting() === 'never') return

    const edit = await this._getRenameEditsWithRetry(renames)

    const files = edit ? affectedResources(edit) : []
    if (!edit || files.length === 0) {
      this._logger.info(`no links to update for ${renames.length} rename(s)`)
      return
    }
    this._logger.info(`${files.length} file(s) to update for ${renames.length} rename(s)`)

    if (this._setting() === 'prompt') {
      const decision = await this._promptUser(files)
      if (decision === 'never' || decision === 'no') return
      // 'always' / 'yes' fall through to apply.
    }

    try {
      const monacoEdit = workspaceEditToMonaco(edit, MonacoLoader.get())
      const result = await this._bulkEdit.apply(monacoEdit.edits, { persistToDisk: true })
      this._logger.info(`applied link updates: ${result.ariaSummary}`)
      await this._notifyServiceOfDiskChanges(renames, files)
    } catch (err) {
      this._logger.error(`applying link updates failed: ${String(err)}`)
    }
  }

  /**
   * Ask the plugin for the link-fixing edits, retrying while the result is empty.
   * An empty edit right after a move is almost always a cold-host not-ready race
   * (see {@link EMPTY_EDIT_RETRIES}); a genuine no-link move just exhausts the
   * cheap background retries. A thrown error (host not started yet) is treated
   * the same as empty so it retries rather than dropping the update silently.
   */
  private async _getRenameEditsWithRetry(
    renames: readonly RenameDto[],
  ): Promise<WorkspaceEdit | null> {
    for (let attempt = 0; attempt <= EMPTY_EDIT_RETRIES; attempt++) {
      if (attempt > 0) await delay(EMPTY_EDIT_RETRY_DELAY_MS)
      if (this._setting() === 'never') return null
      let edit: WorkspaceEdit | null = null
      try {
        await this._client.activateByEvent('onLanguage:markdown')
        edit = (await this._client.executeContributedCommand(GET_RENAME_FILE_EDITS_COMMAND, [
          renames,
        ])) as WorkspaceEdit | null
      } catch (err) {
        this._logger.warn(`getRenameFileEdits failed (attempt ${attempt + 1}): ${String(err)}`)
        continue
      }
      if (edit && affectedResources(edit).length > 0) return edit
    }
    return null
  }

  /**
   * After the bulk edit rewrote closed files on disk, tell the markdown service
   * their content changed — it has no filesystem watcher, so its caches would
   * otherwise keep validating the pre-move link paths and warn they're missing
   * when the file is later reopened. Notify both the edited files and the moved
   * files' old/new paths.
   */
  private async _notifyServiceOfDiskChanges(
    renames: readonly RenameDto[],
    editedFiles: readonly string[],
  ): Promise<void> {
    const uris = new Set<string>(editedFiles)
    for (const r of renames) {
      uris.add(r.oldUri)
      uris.add(r.newUri)
    }
    try {
      await this._client.executeContributedCommand(DID_CHANGE_FILES_COMMAND, [[...uris]])
    } catch (err) {
      this._logger.warn(`didChangeFiles notify failed: ${String(err)}`)
    }
  }

  /** Yes / No / Always / Never, expressed via the three-button confirm + a
   *  "don't ask again" checkbox (checked = persist the Yes/No choice). */
  private async _promptUser(files: readonly string[]): Promise<'yes' | 'no' | 'always' | 'never'> {
    const shown = files.slice(0, MAX_CONFIRM_FILES).map((f) => basename(f))
    const extra = files.length - shown.length
    const detail =
      shown.join(', ') + (extra > 0 ? `, and ${extra} more file${extra === 1 ? '' : 's'}` : '')

    const result = await this._dialog.confirm({
      message:
        files.length === 1
          ? 'Update the Markdown link in 1 file?'
          : `Update Markdown links in ${files.length} files?`,
      detail,
      primaryButton: 'Update',
      cancelButton: "Don't Update",
      neverAskAgainLabel: 'Always do this (never ask again)',
      type: 'info',
    })

    const persist = result.neverAskAgain === true
    if (result.confirmed) {
      if (persist) this._config.update(CONFIG_KEY, 'always', ConfigurationTarget.User)
      return persist ? 'always' : 'yes'
    }
    if (persist) this._config.update(CONFIG_KEY, 'never', ConfigurationTarget.User)
    return persist ? 'never' : 'no'
  }
}
