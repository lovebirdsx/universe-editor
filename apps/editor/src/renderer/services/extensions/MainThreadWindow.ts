/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Renderer-side handler for the host → renderer `mainThreadWindow` channel.
 *  Backs the extension `window.*` namespace by bridging to the editor's own
 *  notification / quick-input / status-bar services. Status-bar items are keyed
 *  by a host-allocated handle so the host can update/dispose them over RPC.
 *
 *  Progress runs work the other way around: `$startProgress` mounts the
 *  workbench progress UI and holds it open on a deferred until `$endProgress`
 *  arrives; a user cancel is pushed back to the host over the `extHostWindow`
 *  channel, where it flips the task's cancellation token.
 *--------------------------------------------------------------------------------------------*/

import {
  DeferredPromise,
  Disposable,
  DisposableMap,
  DisposableStore,
  IDialogService,
  IFileDialogService,
  INotificationService,
  IOpenerService,
  IProgressService,
  IQuickInputService,
  IStatusBarService,
  ProgressLocation,
  Severity,
  StatusBarAlignment,
  toDisposable,
  fsPathToWorkspaceUri,
  type IDisposable,
  type IProgress,
  type IProgressStep,
  type IQuickPick,
  type IQuickPickItem,
  type IStatusBarEntry,
  type IStatusBarEntryAccessor,
} from '@universe-editor/platform'
import {
  type ExtHostMessageSeverity,
  type IExtHostInputBoxOptions,
  type IExtHostQuickPickItemDto,
  type IExtHostQuickPickOptions,
  type IExtHostStatusBarEntryDto,
  type IExtHostWindow,
  type IMainThreadWindow,
  type IOpenDialogOptionsDto,
  type IProgressOptionsDto,
  type IProgressStepDto,
  type ISaveDialogOptionsDto,
} from '@universe-editor/extensions-common'
import { readClipboardText, writeClipboardText } from '@universe-editor/workbench-ui'
import { isDocumentFocused } from '../../workbench/domUtils.js'
import {
  currentWorkbenchDocumentOrUndefined,
  getWorkbenchDocuments,
  onDidAddWorkbenchDocument,
  onDidRemoveWorkbenchDocument,
} from '../windows/workbenchDocuments.js'
import { installPerWorkbenchDocument } from '../windows/workbenchDocumentEvents.js'

function mapSeverity(severity: ExtHostMessageSeverity): Severity {
  return severity === 'error'
    ? Severity.Error
    : severity === 'warning'
      ? Severity.Warning
      : Severity.Info
}

interface ProgressEntry {
  readonly progress: IProgress<IProgressStep>
  readonly done: DeferredPromise<void>
}

/**
 * Wire items → panel rows. The row id is the item's index in the source array,
 * because the index is what crosses back to the host.
 */
function toQuickPickItems(items: Array<string | IExtHostQuickPickItemDto>): IQuickPickItem[] {
  return items.map((it, index) =>
    typeof it === 'string'
      ? { id: String(index), label: it }
      : {
          id: String(index),
          label: it.label,
          ...(it.description !== undefined ? { description: it.description } : {}),
          ...(it.detail !== undefined ? { detail: it.detail } : {}),
          ...(it.iconId !== undefined ? { iconId: it.iconId } : {}),
          ...(it.labelColor !== undefined ? { labelColor: it.labelColor } : {}),
          ...(it.picked !== undefined ? { picked: it.picked } : {}),
        },
  )
}

export class MainThreadWindow extends Disposable implements IMainThreadWindow {
  private readonly _entries = this._register(new DisposableMap<number, IStatusBarEntryAccessor>())
  private readonly _progress = new Map<number, ProgressEntry>()
  private readonly _progressCancels = this._register(new DisposableMap<number, IDisposable>())
  /** Live pickers from `$showQuickPickBusy`, keyed by their host handle. */
  private readonly _busyPicks = new Map<number, IQuickPick<IQuickPickItem>>()
  private _focused = true

  constructor(
    private readonly _notification: INotificationService,
    private readonly _quickInput: IQuickInputService,
    private readonly _statusBar: IStatusBarService,
    private readonly _dialog: IDialogService,
    private readonly _opener: IOpenerService,
    private readonly _progressService: IProgressService,
    private readonly _fileDialogs: IFileDialogService,
    private readonly _extHostWindow: IExtHostWindow,
    /**
     * Remote authority this host is pinned to; undefined for a local workspace.
     * Dialog default locations arrive as bare path strings on the host's own
     * filesystem, so they need the authority re-attached (see `$showOpenDialog`).
     */
    private readonly _authority: string | undefined,
  ) {
    super()
    this._focused = this._computeFocused()
    // Focus/visibility is per workbench window: the extension-visible "focused"
    // state is true while ANY editor window (main or auxiliary) is focused.
    this._register(
      installPerWorkbenchDocument((doc) => {
        const win = doc.defaultView
        const onChange = (): void => this._onFocusChange()
        doc.addEventListener('visibilitychange', onChange)
        win?.addEventListener('focus', onChange)
        win?.addEventListener('blur', onChange)
        return toDisposable(() => {
          doc.removeEventListener('visibilitychange', onChange)
          win?.removeEventListener('focus', onChange)
          win?.removeEventListener('blur', onChange)
        })
      }),
    )
    // Closing or opening a window changes the aggregate without any focus event.
    this._register(onDidAddWorkbenchDocument(() => this._onFocusChange()))
    this._register(onDidRemoveWorkbenchDocument(() => this._onFocusChange()))
  }

  private readonly _onFocusChange = (): void => {
    const focused = this._computeFocused()
    if (focused === this._focused) return
    this._focused = focused
    void this._extHostWindow.$acceptWindowState({ focused }).catch(() => undefined)
  }

  private _computeFocused(): boolean {
    const documents = getWorkbenchDocuments()
    if (documents.length === 0) {
      return isDocumentFocused(currentWorkbenchDocumentOrUndefined())
    }
    return documents.some((doc) => isDocumentFocused(doc))
  }

  /** Seed the host's window focus state once at connect, before any activation. */
  async seedWindowState(): Promise<void> {
    await this._extHostWindow.$acceptWindowState({ focused: this._focused })
  }

  $showMessage(
    severity: ExtHostMessageSeverity,
    message: string,
    items: string[],
  ): Promise<string | undefined> {
    const sev = mapSeverity(severity)
    if (items.length === 0) {
      this._notification.notify({ severity: sev, message })
      return Promise.resolve(undefined)
    }
    // Every item is an action the extension can act on, so they all go through
    // `buttons`: mapping them onto the primary/secondary/cancel triple used to
    // both silently drop items beyond the third and lose the pick entirely
    // whenever a two-item message had its second item clicked.
    return this._dialog
      .confirm({ message, type: severity, buttons: items })
      .then((result) => (result.choiceIndex === undefined ? undefined : items[result.choiceIndex]))
  }

  $showQuickPick(
    items: Array<string | IExtHostQuickPickItemDto>,
    options?: IExtHostQuickPickOptions,
  ): Promise<number | number[] | undefined> {
    const picks = toQuickPickItems(items)
    if (options?.canPickMany === true) {
      return this._pickMany(picks, options)
    }
    return this._quickInput
      .pick(picks, options?.placeHolder !== undefined ? { placeholder: options.placeHolder } : {})
      .then((selected) => (selected ? Number(selected.id) : undefined))
  }

  /**
   * Open a picker whose items are still being fetched, so a slow load shows a
   * progress bar instead of nothing. The items arrive later over
   * `$setQuickPickItems`; dismissing the picker first is fine — the handle is
   * dropped here and the late fill becomes a no-op.
   */
  $showQuickPickBusy(
    handle: number,
    options?: IExtHostQuickPickOptions,
  ): Promise<number | undefined> {
    // A dying host's in-flight request must not leave a picker whose promise
    // nobody can settle (mirrors $startProgress).
    if (this._store.isDisposed) return Promise.resolve(undefined)
    const qp = this._quickInput.createQuickPick<IQuickPickItem>()
    qp.placeholder = options?.placeHolder
    qp.busy = true
    this._busyPicks.set(handle, qp)

    const result = new Promise<number | undefined>((resolve) => {
      // `qp.dispose()` only disposes the QuickPick's own emitters — these two
      // subscriptions are separate disposables, so they need their own store.
      const subs = new DisposableStore()
      const done = (value: number | undefined): void => {
        subs.dispose()
        this._busyPicks.delete(handle)
        qp.dispose()
        resolve(value)
      }
      subs.add(
        qp.onDidAccept((accepted) => {
          const first = accepted[0]
          done(first ? Number(first.id) : undefined)
        }),
      )
      subs.add(qp.onDidHide(() => done(undefined)))
    })
    qp.show()
    return result
  }

  $setQuickPickItems(
    handle: number,
    items: Array<string | IExtHostQuickPickItemDto>,
  ): Promise<void> {
    const qp = this._busyPicks.get(handle)
    if (!qp) return Promise.resolve()
    if (items.length === 0) {
      // Nothing to offer: drop the picker (resolving undefined) instead of
      // leaving the user an empty "No results" panel. `hide()` — not
      // `dispose()`, which only tears down the emitters and would strand the
      // panel on screen with dead handlers.
      qp.hide()
      return Promise.resolve()
    }
    qp.items = toQuickPickItems(items)
    qp.busy = false
    return Promise.resolve()
  }

  $closeQuickPick(handle: number): Promise<void> {
    this._busyPicks.get(handle)?.hide()
    return Promise.resolve()
  }

  /**
   * Multi-select pick: checkboxes per row, `picked` items start checked, and the
   * OK button / Enter confirm the whole checked set (resolving to its indices).
   * The `{0}` placeholder in `okLabel` is substituted with the live checked
   * count, so a label like "Force Get Selected ({0})" tracks the selection.
   */
  private _pickMany(
    picks: IQuickPickItem[],
    options: IExtHostQuickPickOptions,
  ): Promise<number[] | undefined> {
    const okTemplate = options.okLabel
    const formatOk = (count: number): string | undefined =>
      okTemplate === undefined ? undefined : okTemplate.replace('{0}', String(count))

    const qp = this._quickInput.createQuickPick<IQuickPickItem>()
    qp.canSelectMany = true
    qp.title = options.title
    qp.placeholder = options.placeHolder
    qp.items = picks
    qp.selectedItems = picks.filter((p) => p.picked === true)
    qp.okLabel = formatOk(qp.selectedItems.length)

    return new Promise((resolve) => {
      // `qp.dispose()` only disposes the QuickPick's own emitters — the three
      // subscriptions below are separate tracked disposables, so they need
      // their own store or they leak past every settle path.
      const subs = new DisposableStore()
      const done = (value: number[] | undefined): void => {
        subs.dispose()
        qp.dispose()
        resolve(value)
      }
      subs.add(
        qp.onDidChangeSelection((selected) => {
          qp.selectedItems = selected
          qp.okLabel = formatOk(selected.length)
        }),
      )
      subs.add(
        qp.onDidTriggerOk(() => {
          done(qp.selectedItems.map((it) => Number(it.id)))
        }),
      )
      subs.add(qp.onDidHide(() => done(undefined)))
      qp.show()
    })
  }

  $showInputBox(options?: IExtHostInputBoxOptions): Promise<string | undefined> {
    return this._quickInput.input({
      ...(options?.placeHolder !== undefined ? { placeholder: options.placeHolder } : {}),
      ...(options?.prompt !== undefined ? { prompt: options.prompt } : {}),
      ...(options?.value !== undefined ? { value: options.value } : {}),
    })
  }

  $setStatusBarEntry(handle: number, entry: IExtHostStatusBarEntryDto): Promise<void> {
    const data = this._toEntry(entry)
    const existing = this._entries.get(handle)
    if (existing) {
      existing.update(data)
    } else {
      this._entries.set(handle, this._statusBar.addEntry(data))
    }
    return Promise.resolve()
  }

  $disposeStatusBarEntry(handle: number): Promise<void> {
    this._entries.deleteAndDispose(handle)
    return Promise.resolve()
  }

  $clipboardReadText(): Promise<string> {
    return readClipboardText()
  }

  $clipboardWriteText(value: string): Promise<void> {
    return writeClipboardText(value)
  }

  $openExternal(target: string): Promise<boolean> {
    return this._opener.open(target)
  }

  $startProgress(handle: number, options: IProgressOptionsDto): Promise<void> {
    // A dying host's in-flight $startProgress can land after this connection
    // was torn down. Don't mount a progress UI whose deferred can never settle.
    if (this._store.isDisposed) return Promise.resolve()
    const done = new DeferredPromise<void>()
    // ProgressLocation.SourceControl (1) has no dedicated surface here — the
    // quiet status-bar spinner is the closest rendering, as in VSCode's SCM.
    const location =
      options.location === ProgressLocation.Notification
        ? ProgressLocation.Notification
        : ProgressLocation.Window
    const run = this._progressService.withProgress(
      {
        location,
        title: options.title ?? '',
        source: 'extension',
        ...(options.cancellable === true ? { cancellable: true } : {}),
      },
      (progress, token) => {
        // The task body runs synchronously inside withProgress, so the handle is
        // registered before this RPC resolves — a $reportProgress that follows
        // immediately after $startProgress can never arrive to a missing entry.
        const cancelSub = token.onCancellationRequested(() => {
          void this._extHostWindow.$acceptProgressCanceled(handle).catch(() => undefined)
        })
        this._progressCancels.set(handle, cancelSub)
        this._progress.set(handle, { progress, done })
        return done.p
      },
    )
    // The run only rejects if the deferred does (it never does) or the channel
    // died mid-teardown — never surface either as an unhandled rejection.
    void run.catch(() => undefined)
    return Promise.resolve()
  }

  $reportProgress(handle: number, value: IProgressStepDto): Promise<void> {
    this._progress.get(handle)?.progress.report({
      ...(value.message !== undefined ? { message: value.message } : {}),
      ...(value.increment !== undefined ? { increment: value.increment } : {}),
    })
    return Promise.resolve()
  }

  $endProgress(handle: number): Promise<void> {
    const entry = this._progress.get(handle)
    if (entry) {
      this._progress.delete(handle)
      this._progressCancels.deleteAndDispose(handle)
      entry.done.complete(undefined)
    }
    return Promise.resolve()
  }

  async $showOpenDialog(options: IOpenDialogOptionsDto): Promise<string[] | undefined> {
    const picked = await this._fileDialogs.showOpenDialog({
      title: options.title ?? '',
      canSelectFiles: options.canSelectFiles ?? true,
      canSelectFolders: options.canSelectFolders ?? false,
      ...(options.canSelectMany !== undefined ? { canSelectMany: options.canSelectMany } : {}),
      ...(options.filters !== undefined
        ? {
            filters: Object.entries(options.filters).map(([name, extensions]) => ({
              name,
              extensions,
            })),
          }
        : {}),
      ...(options.defaultUri !== undefined
        ? { defaultUri: fsPathToWorkspaceUri(options.defaultUri, this._authority) }
        : {}),
      ...(options.openLabel !== undefined ? { openLabel: options.openLabel } : {}),
    })
    // Host-side paths: the dialog returns resources in the workspace's own URI
    // space (file: locally, remote-ssh: remotely) and `.fsPath` yields the path
    // as that host names it — which is what the extension API hands back.
    return picked?.map((uri) => uri.fsPath)
  }

  async $showSaveDialog(options: ISaveDialogOptionsDto): Promise<string | undefined> {
    const picked = await this._fileDialogs.showSaveDialog({
      title: options.title ?? '',
      canSelectFiles: true,
      canSelectFolders: false,
      ...(options.defaultUri !== undefined
        ? { defaultUri: fsPathToWorkspaceUri(options.defaultUri, this._authority) }
        : {}),
      ...(options.saveLabel !== undefined ? { openLabel: options.saveLabel } : {}),
      ...(options.filters !== undefined
        ? {
            filters: Object.entries(options.filters).map(([name, extensions]) => ({
              name,
              extensions,
            })),
          }
        : {}),
    })
    // Host-side path: the save dialog returns a resource in the workspace's own
    // URI space; `.fsPath` names it as the host does.
    return picked?.fsPath
  }

  override dispose(): void {
    // Connection teardown: settle every held-open progress so its UI tears down.
    for (const [handle, entry] of this._progress) {
      this._progress.delete(handle)
      this._progressCancels.deleteAndDispose(handle)
      entry.done.complete(undefined)
    }
    // Same for pickers still loading: `hide()` resolves their promise (and so
    // the host's `showQuickPick`), which disposing alone would not.
    for (const [, qp] of this._busyPicks) qp.hide()
    super.dispose()
  }

  private _toEntry(entry: IExtHostStatusBarEntryDto): IStatusBarEntry {
    // `$(codicon)` markers in the text are rendered inline by the status bar
    // (mirrors VSCode), so pass the text through untouched.
    const alignment = entry.alignment === 1 ? StatusBarAlignment.Right : StatusBarAlignment.Left
    return {
      text: entry.text,
      alignment,
      priority: entry.priority,
      ...(entry.tooltip !== undefined ? { tooltip: entry.tooltip } : {}),
      ...(entry.command !== undefined ? { command: entry.command } : {}),
      ...(entry.showProgress !== undefined ? { showProgress: entry.showProgress } : {}),
    }
  }
}
