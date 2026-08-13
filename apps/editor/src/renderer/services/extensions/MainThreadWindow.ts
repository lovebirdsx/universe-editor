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
  URI,
  type IConfirmOptions,
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

  constructor(
    private readonly _notification: INotificationService,
    private readonly _quickInput: IQuickInputService,
    private readonly _statusBar: IStatusBarService,
    private readonly _dialog: IDialogService,
    private readonly _opener: IOpenerService,
    private readonly _progressService: IProgressService,
    private readonly _fileDialogs: IFileDialogService,
    private readonly _extHostWindow: IExtHostWindow,
  ) {
    super()
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
    // items[0] is guaranteed by the length check above.
    const primary = items[0]!
    const second = items[1]
    const third = items[2]
    let opts: IConfirmOptions = { message, type: severity, primaryButton: primary }
    if (third !== undefined && second !== undefined) {
      opts = { ...opts, secondaryButton: second, cancelButton: third }
    } else if (second !== undefined) {
      opts = { ...opts, cancelButton: second }
    }
    return this._dialog.confirm(opts).then((result) => {
      if (result.confirmed) return primary
      if (result.choice === 'secondary') return second
      if (result.choice === 'cancel' && third !== undefined) return third
      return undefined
    })
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
        this._progress.set(handle, { progress, done })
        token.onCancellationRequested(() => {
          void this._extHostWindow.$acceptProgressCanceled(handle).catch(() => undefined)
        })
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
      ...(options.defaultUri !== undefined ? { defaultUri: URI.file(options.defaultUri) } : {}),
      ...(options.openLabel !== undefined ? { openLabel: options.openLabel } : {}),
    })
    return picked?.map((uri) => uri.fsPath)
  }

  async $showSaveDialog(options: ISaveDialogOptionsDto): Promise<string | undefined> {
    const picked = await this._fileDialogs.showSaveDialog({
      title: options.title ?? '',
      canSelectFiles: true,
      canSelectFolders: false,
      ...(options.defaultUri !== undefined ? { defaultUri: URI.file(options.defaultUri) } : {}),
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
    return picked?.fsPath
  }

  override dispose(): void {
    // Connection teardown: settle every held-open progress so its UI tears down.
    for (const [handle, entry] of this._progress) {
      this._progress.delete(handle)
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
