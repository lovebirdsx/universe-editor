/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SimpleFileDialog — a QuickInput-based file/folder browser that replaces the
 *  native OS dialogs (mirrors VSCode's files.simpleDialog.enable). Lives entirely
 *  in the renderer; filesystem access goes through IFileService over IPC.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  DisposableStore,
  IConfigurationService,
  IDialogService,
  IFileService,
  IFileDialogService,
  IHostService,
  ILoggerService,
  IQuickInputService,
  IStorageService,
  IWorkspaceService,
  InstantiationType,
  MutableDisposable,
  REMOTE_SCHEME,
  URI,
  createNamedLogger,
  localize,
  registerSingleton,
  remoteFsPathToUri,
  remotePathFromUri,
  type IFileDialogOptions,
  type IKeyMods,
  type ILogger,
  type IQuickPickItem,
} from '@universe-editor/platform'
import { IRemoteStatusService } from '../../../shared/ipc/remoteStatusService.js'
import { currentRemoteAuthority } from '../remote/windowRemoteAuthority.js'
import { resourceIconId } from '../quickInput/quickPickResourceIcon.js'
import {
  endsWithSeparator,
  expandTilde,
  collectFilterExtensions,
  fileExtension,
  isDeletionEdit,
  prepareEntries,
  splitTrailingSegment,
  type DialogEntry,
} from './simpleFileDialogUtil.js'

type DialogMode = 'open' | 'save'

interface ResolvedEntry {
  readonly uri: URI
  readonly isDirectory: boolean
}

const PARENT_ID = '..'
const STORAGE_KEY_SHOW_DOT_FILES = 'fileDialog.showHiddenFiles'
const NATIVE_DIALOG_SETTING = 'files.nativeDialog.enable'

/**
 * Host facts governing path rendering and navigation for one browse target:
 * the client machine for `file:` browsing, or the connected remote host's
 * environment otherwise. Resolved per dialog session from the start folder,
 * before which (`_ctx` fallback) the client context keeps everything working
 * for purely-local flows.
 */
interface BrowseContext {
  /** Path separator of the browsed host. */
  readonly sep: string
  /** Home of the browsed host (for `~` expansion). */
  readonly homeUri: URI
  /**
   * Windows drive-list browsing (C:, D: …). Gated to the local `file:`
   * provider: `listDrives` runs on the main side and can only enumerate local
   * drives, so it is meaningless while browsing a remote host.
   */
  readonly driveList: boolean
}

export class SimpleFileDialog extends Disposable implements IFileDialogService {
  declare readonly _serviceBrand: undefined

  private readonly _clientCtx: BrowseContext
  private _browseCtx: BrowseContext | undefined
  private readonly _logger: ILogger

  // Anchors the current dialog session to this singleton service. Cleanup
  // normally fires on onDidHide; rooting here means an E2E teardown that tears
  // down the window mid-dialog still disposes the in-flight quick pick + subs.
  private readonly _session = this._register(new MutableDisposable<DisposableStore>())

  constructor(
    @IQuickInputService private readonly _quickInput: IQuickInputService,
    @IFileService private readonly _fileService: IFileService,
    @IWorkspaceService private readonly _workspace: IWorkspaceService,
    @IDialogService private readonly _dialog: IDialogService,
    @IStorageService private readonly _storage: IStorageService,
    @IConfigurationService private readonly _config: IConfigurationService,
    @IHostService private readonly _host: IHostService,
    @ILoggerService loggerService: ILoggerService,
    @IRemoteStatusService private readonly _remoteStatus: IRemoteStatusService,
  ) {
    super()
    const ipc = typeof window !== 'undefined' ? window.ipc : undefined
    const sep = ipc?.platform === 'win32' ? '\\' : '/'
    const home = typeof ipc?.home === 'string' ? ipc.home : ''
    this._clientCtx = { sep, homeUri: URI.file(home || '/'), driveList: sep === '\\' }
    this._logger = createNamedLogger(loggerService, { id: 'fileDialog', name: 'File Dialog' })
  }

  private _ctx(): BrowseContext {
    return this._browseCtx ?? this._clientCtx
  }

  /**
   * Resolve the context of the host the dialog will browse. `file:` stays on
   * the client facts; a remote target asks the handshake environment for its
   * OS/home and degrades to POSIX when that is unknown (supported remote
   * targets are POSIX).
   */
  private async _resolveBrowseContext(folder: URI): Promise<BrowseContext> {
    if (folder.scheme !== REMOTE_SCHEME) return this._clientCtx
    const env = await this._remoteStatus.getEnvironment(folder.authority).catch((): null => null)
    return {
      sep: env?.os === 'win32' ? '\\' : '/',
      homeUri: remoteFsPathToUri(env?.homeDir || '/', folder.authority),
      driveList: false,
    }
  }

  showOpenDialog(opts: IFileDialogOptions): Promise<URI[] | undefined> {
    if (this._useNativeDialog(opts)) {
      return this._showNativeOpen(opts)
    }
    return this._show(opts, 'open')
  }

  showSaveDialog(opts: IFileDialogOptions): Promise<URI | undefined> {
    if (this._useNativeDialog(opts)) {
      return this._showNativeSave(opts)
    }
    // The simple dialog resolves an array internally; a save pick holds one URI.
    return this._show(opts, 'save').then((uris) => uris?.[0])
  }

  private _useNativeDialog(opts: IFileDialogOptions): boolean {
    if (this._config.get<boolean>(NATIVE_DIALOG_SETTING) !== true) return false
    const target = opts.defaultUri ?? this._workspace.current?.folder
    // The native OS dialog only understands local filesystem paths: a non-file
    // start point (remote-ssh) must go through the simple dialog.
    if (target !== undefined && target.scheme !== 'file') return false
    // An empty remote window starts in the remote home; the native dialog would
    // open in the local filesystem instead.
    if (target === undefined && currentRemoteAuthority(this._workspace.current)) return false
    return true
  }

  private async _showNativeOpen(opts: IFileDialogOptions): Promise<URI[] | undefined> {
    this._logger.debug(`native open dialog title=${opts.title}`)
    // 本机路径：原生对话框面向本地文件系统，defaultPath 与返回的 uri 都是 file:。
    const picked = await this._host.showOpenFileDialog({
      title: opts.title,
      ...(opts.defaultUri !== undefined ? { defaultPath: opts.defaultUri.fsPath } : {}),
      canSelectFiles: opts.canSelectFiles,
      canSelectFolders: opts.canSelectFolders,
      ...(opts.canSelectMany !== undefined ? { canSelectMany: opts.canSelectMany } : {}),
      ...(opts.filters !== undefined ? { filters: opts.filters } : {}),
      ...(opts.openLabel !== undefined ? { buttonLabel: opts.openLabel } : {}),
    })
    if (!picked || picked.length === 0) {
      this._logger.debug('native open dialog cancelled')
      return undefined
    }
    const uris = picked.map((p) => (p instanceof URI ? p : URI.from(p)))
    this._logger.debug(`native open dialog picked ${uris.map((u) => u.fsPath).join(', ')}`)
    return uris
  }

  private async _showNativeSave(opts: IFileDialogOptions): Promise<URI | undefined> {
    this._logger.debug(`native save dialog title=${opts.title}`)
    // 本机路径：原生对话框面向本地文件系统，defaultPath 与返回的 uri 都是 file:。
    const picked = await this._host.showSaveFileDialog({
      title: opts.title,
      ...(opts.defaultUri !== undefined ? { defaultPath: opts.defaultUri.fsPath } : {}),
      ...(opts.openLabel !== undefined ? { buttonLabel: opts.openLabel } : {}),
    })
    if (!picked) {
      this._logger.debug('native save dialog cancelled')
      return undefined
    }
    const uri = picked instanceof URI ? picked : URI.from(picked)
    this._logger.debug(`native save dialog picked ${uri.fsPath}`)
    return uri
  }

  private async _show(opts: IFileDialogOptions, mode: DialogMode): Promise<URI[] | undefined> {
    const allowFiles = opts.canSelectFiles
    const canSelectMany = mode === 'open' && opts.canSelectMany === true
    // Extension filters narrow the listed files; save mode never filters.
    const fileExts =
      mode === 'open' && allowFiles ? collectFilterExtensions(opts.filters) : undefined
    const start = await this._resolveStart(opts, mode)
    // Pin the browsed host's context for the whole session (navigation inside a
    // dialog never crosses authorities, so one resolution suffices).
    this._browseCtx = await this._resolveBrowseContext(start.folder)
    const initialShowDotFiles =
      (await this._storage.get<boolean>(STORAGE_KEY_SHOW_DOT_FILES)) === true

    return new Promise<URI[] | undefined>((resolve) => {
      const session = new DisposableStore()
      this._session.value = session
      const qp = session.add(this._quickInput.createQuickPick<IQuickPickItem>())
      qp.filterExternally = true
      qp.keepOpenOnAccept = true
      qp.autoFocusFirstItem = false
      qp.canSelectMany = canSelectMany
      qp.title = opts.title
      qp.okLabel = opts.openLabel ?? localize('fileDialog.ok', 'OK')

      let currentFolder = start.folder
      let showDotFiles = initialShowDotFiles
      let currentItems: IQuickPickItem[] = []
      let entriesById = new Map<string, ResolvedEntry>()
      // Checked entries in multi-select mode, keyed by item id (= entry URI).
      // `item` is the row snapshot for re-rendering the checkbox; `entry` keeps
      // the URI so a pick survives navigation into another folder.
      const selected = new Map<string, { item: IQuickPickItem; entry: ResolvedEntry }>()
      let settled = false
      let lastValue = ''
      let userTypedSegment = ''
      // The value the user actually typed before the last completion appended a
      // selected tail. Lets onValueChange tell "typing forward over the selection"
      // (not a deletion) apart from "backspacing the tail" (a deletion).
      let autoCompleteBase: string | undefined
      let navToken = 0
      // Guards against re-entrant accepts while a create-confirmation is open.
      // The QuickInput keeps focus contention with the dialog, so a second Enter
      // would otherwise queue a duplicate confirm dialog.
      let confirming = false
      // Modifier held at the accept (Enter / click / OK) that led to the finish.
      // Written into `opts.keyMods` so the caller can branch (Ctrl+Enter → new window).
      let lastAcceptMods: IKeyMods = { ctrl: false, alt: false }

      const syncHiddenButton = (): void => {
        qp.buttons = [
          showDotFiles
            ? {
                id: 'toggle-hidden',
                iconId: 'eye-off',
                tooltip: localize('fileDialog.hideHidden', 'Hide Hidden Files'),
              }
            : {
                id: 'toggle-hidden',
                iconId: 'eye',
                tooltip: localize('fileDialog.showHidden', 'Show Hidden Files'),
              },
        ]
      }
      syncHiddenButton()

      const finish = (uris: URI[] | undefined): void => {
        if (settled) return
        settled = true
        if (opts.keyMods) {
          opts.keyMods.ctrl = lastAcceptMods.ctrl
          opts.keyMods.alt = lastAcceptMods.alt
        }
        this._browseCtx = undefined
        qp.hide()
        if (this._session.value === session) this._session.clear()
        else session.dispose()
        resolve(uris)
      }

      const confirmAndFinish = async (target: URI): Promise<void> => {
        if (mode === 'save' && (await this._fileService.exists(target))) {
          const { confirmed } = await this._dialog.confirm({
            message: localize(
              'fileDialog.overwrite',
              "A file named '{name}' already exists. Do you want to replace it?",
              { name: this._basename(target) },
            ),
            primaryButton: localize('fileDialog.replace', 'Replace'),
            type: 'warning',
          })
          if (!confirmed) return
        }
        finish([target])
      }

      // In multi-select mode the OK button confirms the checked set; with nothing
      // checked it falls back to resolving the typed path (single-pick semantics).
      const confirmSelectionOrValue = (mods: IKeyMods): void => {
        lastAcceptMods = mods
        if (canSelectMany && selected.size > 0) {
          finish([...selected.values()].map((s) => s.entry.uri))
          return
        }
        void acceptValue(qp.value)
      }

      // A row is checkable when it names a real entry the picker allows picking:
      // files in a file picker, folders in a folder picker. '..' never checks.
      const isSelectableEntry = (id: string, entry: ResolvedEntry): boolean =>
        id !== PARENT_ID && (entry.isDirectory ? opts.canSelectFolders : allowFiles)

      const syncSelectedItems = (): void => {
        qp.selectedItems = [...selected.values()].map((s) => s.item)
      }

      const toggleSelected = (item: IQuickPickItem): void => {
        const entry = entriesById.get(item.id)
        if (!entry || !isSelectableEntry(item.id, entry)) return
        if (selected.has(item.id)) selected.delete(item.id)
        else selected.set(item.id, { item, entry })
        syncSelectedItems()
      }

      const setInputToFolder = (): void => {
        const v = this._isDriveListRoot(currentFolder) ? '' : this._displayWithSep(currentFolder)
        lastValue = v
        qp.value = v
        qp.valueSelection = undefined
      }

      const updateItems = async (folder: URI, listOpts: { resetInput: boolean }): Promise<void> => {
        const token = ++navToken
        qp.busy = true
        const items: IQuickPickItem[] = []
        const byId = new Map<string, ResolvedEntry>()

        if (this._isDriveListRoot(folder)) {
          let drives: string[] = []
          try {
            drives = (await this._fileService.listDrives?.()) ?? []
          } catch {
            drives = []
          }
          if (token !== navToken) return
          currentFolder = folder
          for (const drive of drives) {
            const uri = this._uriFromInput(drive)
            const id = uri.toString()
            items.push({ id, label: drive, iconId: resourceIconId(uri, true) })
            byId.set(id, { uri, isDirectory: true })
          }
        } else {
          let entries: DialogEntry[] = []
          try {
            entries = await this._fileService.list(folder)
          } catch {
            entries = []
          }
          if (token !== navToken) return
          currentFolder = folder
          const prepared = prepareEntries(entries, { allowFiles, showDotFiles, fileExts })

          const parent = this._parentOf(folder)
          if (parent) {
            items.push({ id: PARENT_ID, label: '..', iconId: resourceIconId(parent, true) })
            byId.set(PARENT_ID, { uri: parent, isDirectory: true })
          }
          for (const entry of prepared) {
            const child = URI.joinPath(folder, entry.name)
            const id = child.toString()
            items.push({ id, label: entry.name, iconId: resourceIconId(child, entry.isDirectory) })
            byId.set(id, { uri: child, isDirectory: entry.isDirectory })
          }
        }

        currentItems = items
        entriesById = byId
        qp.items = items
        qp.busy = false
        if (listOpts.resetInput) setInputToFolder()
      }

      // Autocomplete the input to `item`, selecting the untyped tail so the next
      // keystroke replaces it. Records the committed-so-far prefix (value minus the
      // selected tail) as the completion base, so a forward keystroke over the
      // selection is not mistaken for a backspace.
      const completeToItem = (item: IQuickPickItem): void => {
        const prefix = this._isDriveListRoot(currentFolder)
          ? ''
          : this._displayWithSep(currentFolder)
        const completed = item.id === PARENT_ID ? prefix + '..' : prefix + item.label
        const startsWithTyped =
          item.id !== PARENT_ID &&
          item.label.toLowerCase().startsWith(userTypedSegment.toLowerCase())
        const typedLen = startsWithTyped ? userTypedSegment.length : 0
        const selStart = Math.min(prefix.length + typedLen, completed.length)
        autoCompleteBase = completed.slice(0, selStart)
        lastValue = completed
        qp.value = completed
        qp.valueSelection = [selStart, completed.length]
      }

      // Clear the highlight and any pending completion selection. Setting only
      // activeItems is not enough: a leftover valueSelection would be re-applied
      // by the panel and re-select the character the user just typed, so the next
      // keystroke replaces it (the "can only type one char past an existing path"
      // bug). Always drop the selection when nothing is being completed.
      const clearCompletion = (): void => {
        qp.activeItems = []
        qp.valueSelection = undefined
      }

      // Highlight the entry whose name prefixes the typed trailing segment and
      // autocomplete to it directly. Going through activeItems alone is not enough:
      // the panel dedupes onDidChangeActive by item id, so re-matching the same
      // entry (typing the next matched char) would not re-fire the completion.
      const applyMatch = (name: string): void => {
        const lower = name.toLowerCase()
        const match = currentItems.find(
          (it) => it.id !== PARENT_ID && it.label.toLowerCase().startsWith(lower),
        )
        if (match) {
          qp.activeItems = [match]
          completeToItem(match)
        } else {
          clearCompletion()
        }
      }

      const onValueChange = async (value: string): Promise<void> => {
        const expanded = expandTilde(value, this._display(this._homeUri()), this._ctx().sep)
        if (expanded !== undefined) {
          value = expanded
          lastValue = expanded
          qp.value = expanded
        }

        const deletion = isDeletionEdit(lastValue, value, autoCompleteBase)
        lastValue = value
        // Drop the previous completion base; completeToItem re-establishes it only
        // when this change actually autocompletes to a match.
        autoCompleteBase = undefined

        const { dir, name } = splitTrailingSegment(value)
        userTypedSegment = name

        // Browsing the local drive list: a value with no directory part is a
        // fresh top-level entry — the user cleared the box and is typing a
        // drive (or nothing). Surface the drive list and match drives by the
        // typed prefix, instead of autocompleting the bare segment into the
        // current folder.
        if (dir === '' && this._ctx().driveList) {
          if (!this._isDriveListRoot(currentFolder)) {
            await updateItems(this._driveListRoot(), { resetInput: false })
          }
          if (!deletion && name !== '') applyMatch(name)
          else clearCompletion()
          return
        }

        // [A] When the typed directory part differs from the current folder, sync
        // the listing to it (without clobbering what the user is typing).
        if (dir !== '') {
          const dirUri = this._uriFromInput(dir, currentFolder)
          if (dirUri.path !== currentFolder.path) {
            try {
              const stat = await this._fileService.stat(dirUri)
              if (stat.isDirectory) {
                await updateItems(dirUri, { resetInput: false })
              } else {
                clearCompletion()
                return
              }
            } catch {
              clearCompletion()
              return
            }
          }
        }

        // [B] Match-highlight the trailing segment, unless the user is deleting.
        if (!deletion && name !== '') applyMatch(name)
        else clearCompletion()
      }

      // [C] Autocomplete the input to the focused item as the user arrows through
      // the list. The untyped tail is selected so the next keystroke replaces it.
      const onActiveChange = (item: IQuickPickItem | undefined): void => {
        if (!item) return
        if (!entriesById.has(item.id)) return
        completeToItem(item)
      }

      const setSaveValue = (uri: URI): void => {
        const v = this._display(uri)
        lastValue = v
        qp.value = v
        qp.valueSelection = undefined
      }

      // Offer to create a path the user typed that does not exist yet (VSCode
      // parity). A trailing separator, or a folder-only picker, means a folder;
      // otherwise a file (its missing parent dirs are created too). Confirms first.
      const offerCreate = async (value: string, target: URI): Promise<void> => {
        if (confirming) return
        confirming = true
        try {
          const asFolder = endsWithSeparator(value) || (!allowFiles && opts.canSelectFolders)
          const name = this._display(target)
          const { confirmed } = await this._dialog.confirm({
            message: asFolder
              ? localize('fileDialog.createFolder', "Folder '{name}' does not exist. Create it?", {
                  name,
                })
              : localize('fileDialog.createFile', "File '{name}' does not exist. Create it?", {
                  name,
                }),
            primaryButton: localize('fileDialog.create', 'Create'),
            type: 'info',
          })
          if (!confirmed) return
          if (asFolder) {
            await this._fileService.createDirectory(target)
          } else {
            const parent = this._parentOf(target)
            if (parent) await this._fileService.createDirectory(parent)
            await this._fileService.writeFile(target, '')
          }
          finish([target])
        } catch {
          // creation failed — keep the dialog open
        } finally {
          confirming = false
        }
      }

      // Resolve the typed value directly: enter / select a folder, open a file, or
      // confirm a save target. [D] A trailing separator means "this folder itself".
      // When a filter is active a file outside it is not openable (matches the
      // list filtering in updateItems, which drops such rows).
      const acceptValue = async (value: string): Promise<void> => {
        if (value === '') return
        const target = this._uriFromInput(value, currentFolder)
        if (mode === 'save') {
          if (endsWithSeparator(value)) return
          await confirmAndFinish(target)
          return
        }
        try {
          const stat = await this._fileService.stat(target)
          if (stat.isDirectory) {
            if (opts.canSelectFolders) finish([target])
            else await updateItems(target, { resetInput: true })
          } else if (stat.isFile && allowFiles) {
            if (fileExts && !fileExts.has(fileExtension(this._basename(target)))) return
            finish([target])
          }
        } catch {
          // path does not exist — offer to create it
          await offerCreate(value, target)
        }
      }

      const onAccept = async (items: IQuickPickItem[]): Promise<void> => {
        // Record the modifier for the accept that is about to run (Enter / click).
        // `qp.keyMods` reflects the latest accept because the QuickInput service
        // updates it before firing onDidAccept.
        lastAcceptMods = { ctrl: qp.keyMods.ctrl, alt: qp.keyMods.alt }
        // A concrete item was chosen (clicked, or focused + Enter): act on it
        // directly. This is independent of the input value, so it can't race the
        // autocomplete that lags a click. [B/C]
        const active = items[0]
        if (active) {
          const entry = entriesById.get(active.id)
          if (entry) {
            if (entry.isDirectory) {
              await updateItems(entry.uri, { resetInput: true })
              return
            }
            if (mode === 'save') {
              setSaveValue(entry.uri)
              return
            }
            if (allowFiles) {
              if (fileExts && !fileExts.has(fileExtension(active.label))) return
              // Multi-select: accepting a file toggles its checkbox instead of
              // closing; the OK button confirms the whole checked set.
              if (canSelectMany) {
                toggleSelected(active)
                return
              }
              finish([entry.uri])
            }
            return
          }
        }

        // No item selected → resolve the typed value: a trailing-separator path
        // opens that folder [D], a full path opens the file / enters the folder.
        await acceptValue(qp.value)
      }

      qp.onDidAccept((items) => void onAccept(items), undefined, session)
      qp.onDidChangeValue((value) => void onValueChange(value), undefined, session)
      qp.onDidChangeActive((item) => onActiveChange(item), undefined, session)
      qp.onDidTriggerOk((mods) => confirmSelectionOrValue(mods), undefined, session)
      qp.onDidChangeSelection(
        (items) => {
          // The panel proposes the next checked set. Adopt it, but drop rows that
          // are not selectable (folders in a file picker, '..') and keep picks
          // recorded in other folders (their ids are absent from the rebuilt
          // entriesById after navigation).
          const next = new Map<string, { item: IQuickPickItem; entry: ResolvedEntry }>()
          for (const item of items) {
            const entry = entriesById.get(item.id)
            if (entry) {
              if (isSelectableEntry(item.id, entry)) next.set(item.id, { item, entry })
              continue
            }
            const carried = selected.get(item.id)
            if (carried) next.set(item.id, carried)
          }
          selected.clear()
          for (const [id, value] of next) selected.set(id, value)
          syncSelectedItems()
        },
        undefined,
        session,
      )
      qp.onDidTriggerButton(
        () => {
          showDotFiles = !showDotFiles
          void this._storage.set(STORAGE_KEY_SHOW_DOT_FILES, showDotFiles)
          syncHiddenButton()
          void updateItems(currentFolder, { resetInput: false })
        },
        undefined,
        session,
      )
      qp.onDidHide(() => finish(undefined), undefined, session)

      qp.show()
      void (async () => {
        await updateItems(start.folder, { resetInput: true })
        if (mode === 'save' && start.fileName) {
          const folderPrefix = this._displayWithSep(start.folder)
          const v = folderPrefix + start.fileName
          lastValue = v
          qp.value = v
          qp.valueSelection = [folderPrefix.length, folderPrefix.length + start.fileName.length]
        }
      })()
    })
  }

  private async _resolveStart(
    opts: IFileDialogOptions,
    mode: DialogMode,
  ): Promise<{ folder: URI; fileName?: string }> {
    const workspaceFolder = this._workspace.current?.folder
    let homeFallback: Promise<URI> | undefined
    const resolveHome = (): Promise<URI> => {
      if (workspaceFolder) return Promise.resolve(workspaceFolder)
      return (homeFallback ??= this._resolveHomeUri())
    }

    if (mode === 'save' && opts.defaultUri) {
      return {
        folder: this._parentOf(opts.defaultUri) ?? (await resolveHome()),
        fileName: this._basename(opts.defaultUri),
      }
    }
    const base = opts.defaultUri ?? (await resolveHome())
    try {
      const stat = await this._fileService.stat(base)
      if (stat.isDirectory) return { folder: base }
      return { folder: this._parentOf(base) ?? (await resolveHome()) }
    } catch {
      return { folder: await resolveHome() }
    }
  }

  /**
   * The home used as the default start point when neither a defaultUri nor a
   * workspace folder is available. An empty remote window starts in the remote
   * user home; any failure to resolve it degrades to the local home so the
   * dialog still opens.
   */
  private async _resolveHomeUri(): Promise<URI> {
    const authority = currentRemoteAuthority(this._workspace.current)
    if (!authority) return this._homeUri()
    try {
      const env = await this._remoteStatus.getEnvironment(authority)
      if (env) return remoteFsPathToUri(env.homeDir, authority)
    } catch (err) {
      this._logger.warn(
        `fileDialog: resolving remote home for ${authority} failed, falling back to local home (${
          err instanceof Error ? err.message : String(err)
        })`,
      )
      return this._homeUri()
    }
    this._logger.warn(
      `fileDialog: remote environment for ${authority} not available, falling back to local home`,
    )
    return this._homeUri()
  }

  private _homeUri(): URI {
    return this._ctx().homeUri
  }

  private _parentOf(uri: URI): URI | undefined {
    const parent = URI.joinPath(uri, '..')
    return parent.path === uri.path ? undefined : parent
  }

  private _basename(uri: URI): string {
    const path = uri.path
    const idx = path.lastIndexOf('/')
    return idx === -1 ? path : path.slice(idx + 1)
  }

  private _display(uri: URI): string {
    const sep = this._ctx().sep
    // file: 与 remote-ssh 都渲染浏览主机的原生路径（remote 经 remotePathFromUri
    // 取服务端路径，盘符前导斜杠由 _uriFromInput 的 remoteFsPathToUri 补回）；
    // 其它 scheme 无原生路径可渲染，保留 URI path。
    const native =
      uri.scheme === 'file'
        ? uri.fsPath
        : uri.scheme === REMOTE_SCHEME
          ? remotePathFromUri(uri)
          : null
    if (native === null) return uri.path
    return sep === '/' ? native : native.replace(/\//g, sep)
  }

  private _uriFromInput(value: string, base?: URI): URI {
    let normalized = value.replace(/\\/g, '/')
    while (normalized.length > 1 && normalized.endsWith('/')) {
      normalized = normalized.slice(0, -1)
    }
    // A bare Windows drive ("D:") addresses the drive's working directory, not
    // its root; keep the trailing slash so it resolves to the drive root ("D:/").
    if (/^[A-Za-z]:$/.test(normalized)) {
      normalized += '/'
    }
    // 远端路径沿用当前目录的 scheme/authority，不再恒为 file:。
    if (base !== undefined && base.scheme !== 'file') {
      // remote-ssh 用 remoteFsPathToUri 补回盘符前导斜杠，与 _display 的
      // remotePathFromUri 互为逆操作（round-trip 不丢 `/<drive>:` 结构）。
      if (base.scheme === REMOTE_SCHEME) {
        return remoteFsPathToUri(normalized, base.authority)
      }
      return URI.from({ scheme: base.scheme, authority: base.authority, path: normalized })
    }
    return URI.file(normalized)
  }

  /** The synthetic "list of drives" root, shown on Windows above all drives. */
  private _driveListRoot(): URI {
    return URI.file('/')
  }

  /** Whether `uri` is the drive-list root (filesystem root of the local win32). */
  private _isDriveListRoot(uri: URI): boolean {
    return this._ctx().driveList && uri.scheme === 'file' && uri.path === '/'
  }

  private _displayWithSep(uri: URI): string {
    const sep = this._ctx().sep
    const display = this._display(uri)
    return display.endsWith(sep) ? display : display + sep
  }
}

registerSingleton(IFileDialogService, SimpleFileDialog, InstantiationType.Delayed)
