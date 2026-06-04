/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Renderer-side handler for the host → renderer `mainThreadWindow` channel.
 *  Backs the extension `window.*` namespace by bridging to the editor's own
 *  notification / quick-input / status-bar services. Status-bar items are keyed
 *  by a host-allocated handle so the host can update/dispose them over RPC.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  INotificationService,
  IQuickInputService,
  IStatusBarService,
  Severity,
  StatusBarAlignment,
  type IQuickPickItem,
  type IStatusBarEntry,
  type IStatusBarEntryAccessor,
} from '@universe-editor/platform'
import {
  type ExtHostMessageSeverity,
  type IExtHostInputBoxOptions,
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
  private readonly _entries = new Map<number, IStatusBarEntryAccessor>()

  constructor(
    private readonly _notification: INotificationService,
    private readonly _quickInput: IQuickInputService,
    private readonly _statusBar: IStatusBarService,
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
    return new Promise<string | undefined>((resolve) => {
      let picked: string | undefined
      const choices = items.map((label) => ({
        label,
        run: () => {
          picked = label
        },
      }))
      void this._notification.prompt(sev, message, choices).then(() => resolve(picked))
    })
  }

  $showQuickPick(items: string[], options?: IExtHostQuickPickOptions): Promise<string | undefined> {
    const picks: IQuickPickItem[] = items.map((label, index) => ({ id: String(index), label }))
    return this._quickInput
      .pick(picks, options?.placeHolder !== undefined ? { placeholder: options.placeHolder } : {})
      .then((selected) => selected?.label)
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
    this._entries.get(handle)?.dispose()
    this._entries.delete(handle)
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
    }
  }

  override dispose(): void {
    for (const entry of this._entries.values()) entry.dispose()
    this._entries.clear()
    super.dispose()
  }
}
