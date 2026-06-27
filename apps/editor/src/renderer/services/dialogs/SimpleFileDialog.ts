/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  SimpleFileDialog — a QuickInput-based file/folder browser that replaces the
 *  native OS dialogs (mirrors VSCode's files.simpleDialog.enable). Lives entirely
 *  in the renderer; filesystem access goes through IFileService over IPC.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  DisposableStore,
  IDialogService,
  IFileService,
  IFileDialogService,
  IQuickInputService,
  IStorageService,
  IWorkspaceService,
  InstantiationType,
  MutableDisposable,
  URI,
  localize,
  registerSingleton,
  type IFileDialogOptions,
  type IQuickPickItem,
} from '@universe-editor/platform'
import { resourceIconId } from '../quickInput/quickPickResourceIcon.js'
import {
  endsWithSeparator,
  expandTilde,
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

export class SimpleFileDialog extends Disposable implements IFileDialogService {
  declare readonly _serviceBrand: undefined

  private readonly _sep: string
  private readonly _home: string

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
  ) {
    super()
    const ipc = typeof window !== 'undefined' ? window.ipc : undefined
    this._sep = ipc?.platform === 'win32' ? '\\' : '/'
    this._home = typeof ipc?.home === 'string' ? ipc.home : ''
  }

  showOpenDialog(opts: IFileDialogOptions): Promise<URI | undefined> {
    return this._show(opts, 'open')
  }

  showSaveDialog(opts: IFileDialogOptions): Promise<URI | undefined> {
    return this._show(opts, 'save')
  }

  private async _show(opts: IFileDialogOptions, mode: DialogMode): Promise<URI | undefined> {
    const allowFiles = opts.canSelectFiles
    const start = await this._resolveStart(opts, mode)
    const initialShowDotFiles =
      (await this._storage.get<boolean>(STORAGE_KEY_SHOW_DOT_FILES)) === true

    return new Promise<URI | undefined>((resolve) => {
      const session = new DisposableStore()
      this._session.value = session
      const qp = session.add(this._quickInput.createQuickPick<IQuickPickItem>())
      qp.filterExternally = true
      qp.keepOpenOnAccept = true
      qp.autoFocusFirstItem = false
      qp.title = opts.title
      qp.okLabel = opts.openLabel ?? localize('fileDialog.ok', 'OK')

      let currentFolder = start.folder
      let showDotFiles = initialShowDotFiles
      let currentItems: IQuickPickItem[] = []
      let entriesById = new Map<string, ResolvedEntry>()
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

      const finish = (uri: URI | undefined): void => {
        if (settled) return
        settled = true
        qp.hide()
        if (this._session.value === session) this._session.clear()
        else session.dispose()
        resolve(uri)
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
        finish(target)
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
          const prepared = prepareEntries(entries, { allowFiles, showDotFiles })

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
        const expanded = expandTilde(value, this._display(this._homeUri()), this._sep)
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

        // On Windows a value with no directory part is a fresh top-level entry:
        // the user cleared the box and is typing a drive (or nothing). Surface
        // the drive list and match drives by the typed prefix, instead of
        // autocompleting the bare segment into the current folder.
        if (dir === '' && this._sep === '\\') {
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
          const dirUri = this._uriFromInput(dir)
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
          finish(target)
        } catch {
          // creation failed — keep the dialog open
        } finally {
          confirming = false
        }
      }

      // Resolve the typed value directly: enter / select a folder, open a file, or
      // confirm a save target. [D] A trailing separator means "this folder itself".
      const acceptValue = async (value: string): Promise<void> => {
        if (value === '') return
        const target = this._uriFromInput(value)
        if (mode === 'save') {
          if (endsWithSeparator(value)) return
          await confirmAndFinish(target)
          return
        }
        try {
          const stat = await this._fileService.stat(target)
          if (stat.isDirectory) {
            if (opts.canSelectFolders) finish(target)
            else await updateItems(target, { resetInput: true })
          } else if (stat.isFile && allowFiles) {
            finish(target)
          }
        } catch {
          // path does not exist — offer to create it
          await offerCreate(value, target)
        }
      }

      const onAccept = async (items: IQuickPickItem[]): Promise<void> => {
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
              finish(entry.uri)
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
      qp.onDidTriggerOk(() => void acceptValue(qp.value), undefined, session)
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
    const fallback = this._workspace.current?.folder ?? this._homeUri()
    if (mode === 'save' && opts.defaultUri) {
      return {
        folder: this._parentOf(opts.defaultUri) ?? fallback,
        fileName: this._basename(opts.defaultUri),
      }
    }
    const base = opts.defaultUri ?? fallback
    try {
      const stat = await this._fileService.stat(base)
      if (stat.isDirectory) return { folder: base }
      return { folder: this._parentOf(base) ?? fallback }
    } catch {
      return { folder: fallback }
    }
  }

  private _homeUri(): URI {
    return URI.file(this._home || '/')
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
    return this._sep === '/' ? uri.fsPath : uri.fsPath.replace(/\//g, this._sep)
  }

  private _uriFromInput(value: string): URI {
    let normalized = value.replace(/\\/g, '/')
    while (normalized.length > 1 && normalized.endsWith('/')) {
      normalized = normalized.slice(0, -1)
    }
    // A bare Windows drive ("D:") addresses the drive's working directory, not
    // its root; keep the trailing slash so it resolves to the drive root ("D:/").
    if (/^[A-Za-z]:$/.test(normalized)) {
      normalized += '/'
    }
    return URI.file(normalized)
  }

  /** The synthetic "list of drives" root, shown on Windows above all drives. */
  private _driveListRoot(): URI {
    return URI.file('/')
  }

  /** Whether `uri` is the Windows drive-list root (filesystem root on win32). */
  private _isDriveListRoot(uri: URI): boolean {
    return this._sep === '\\' && uri.scheme === 'file' && uri.path === '/'
  }

  private _displayWithSep(uri: URI): string {
    const display = this._display(uri)
    return display.endsWith(this._sep) ? display : display + this._sep
  }
}

registerSingleton(IFileDialogService, SimpleFileDialog, InstantiationType.Delayed)
