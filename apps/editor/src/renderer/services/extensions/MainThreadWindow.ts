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
import { isWindowFocused } from '../../workbench/domUtils.js'

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

export class MainThreadWindow extends Disposable implements IMainThreadWindow {
  private readonly _entries = this._register(new DisposableMap<number, IStatusBarEntryAccessor>())
  private readonly _progress = new Map<number, ProgressEntry>()
  private readonly _progressCancels = this._register(new DisposableMap<number, IDisposable>())
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
    window.addEventListener('focus', this._onFocusChange)
    window.addEventListener('blur', this._onFocusChange)
    document.addEventListener('visibilitychange', this._onFocusChange)
    this._register(
      toDisposable(() => {
        window.removeEventListener('focus', this._onFocusChange)
        window.removeEventListener('blur', this._onFocusChange)
        document.removeEventListener('visibilitychange', this._onFocusChange)
      }),
    )
  }

  private readonly _onFocusChange = (): void => {
    const focused = this._computeFocused()
    if (focused === this._focused) return
    this._focused = focused
    void this._extHostWindow.$acceptWindowState({ focused }).catch(() => undefined)
  }

  private _computeFocused(): boolean {
    return isWindowFocused()
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
  ): Promise<number | undefined> {
    const picks: IQuickPickItem[] = items.map((it, index) =>
      typeof it === 'string'
        ? { id: String(index), label: it }
        : {
            id: String(index),
            label: it.label,
            ...(it.description !== undefined ? { description: it.description } : {}),
            ...(it.detail !== undefined ? { detail: it.detail } : {}),
            ...(it.iconId !== undefined ? { iconId: it.iconId } : {}),
          },
    )
    return this._quickInput
      .pick(picks, options?.placeHolder !== undefined ? { placeholder: options.placeHolder } : {})
      .then((selected) => (selected ? Number(selected.id) : undefined))
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
    return navigator.clipboard.readText()
  }

  $clipboardWriteText(value: string): Promise<void> {
    return navigator.clipboard.writeText(value)
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
