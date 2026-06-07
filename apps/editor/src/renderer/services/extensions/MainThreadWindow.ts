/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Renderer-side handler for the host → renderer `mainThreadWindow` channel.
 *  Backs the extension `window.*` namespace by bridging to the editor's own
 *  notification / quick-input / status-bar services. Status-bar items are keyed
 *  by a host-allocated handle so the host can update/dispose them over RPC.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  DisposableMap,
  IDialogService,
  INotificationService,
  IQuickInputService,
  IStatusBarService,
  Severity,
  StatusBarAlignment,
  type IConfirmOptions,
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
  type IMainThreadWindow,
} from '@universe-editor/extensions-common'

/** Leading `$(icon)` syntax in status-bar text → a separate icon field. */
const ICON_PREFIX = /^\$\(([^)]+)\)\s*/

function mapSeverity(severity: ExtHostMessageSeverity): Severity {
  return severity === 'error'
    ? Severity.Error
    : severity === 'warning'
      ? Severity.Warning
      : Severity.Info
}

export class MainThreadWindow extends Disposable implements IMainThreadWindow {
  private readonly _entries = this._register(new DisposableMap<number, IStatusBarEntryAccessor>())

  constructor(
    private readonly _notification: INotificationService,
    private readonly _quickInput: IQuickInputService,
    private readonly _statusBar: IStatusBarService,
    private readonly _dialog: IDialogService,
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

  private _toEntry(entry: IExtHostStatusBarEntryDto): IStatusBarEntry {
    const match = ICON_PREFIX.exec(entry.text)
    const icon = match?.[1]
    const text = match ? entry.text.slice(match[0].length) : entry.text
    const alignment = entry.alignment === 1 ? StatusBarAlignment.Right : StatusBarAlignment.Left
    return {
      text,
      alignment,
      priority: entry.priority,
      ...(icon !== undefined ? { icon } : {}),
      ...(entry.tooltip !== undefined ? { tooltip: entry.tooltip } : {}),
      ...(entry.command !== undefined ? { command: entry.command } : {}),
      ...(entry.showProgress !== undefined ? { showProgress: entry.showProgress } : {}),
    }
  }
}
