/*---------------------------------------------------------------------------------------------
 *  WindowFocusService — move the OS focus to the workbench window that owns a
 *  group/part. Renderer-level activation (`activateGroup`) only changes the
 *  in-process state; without this a command running in the main window can
 *  reveal an editor in an auxiliary window while keyboard focus stays behind.
 *
 *  `document.hasFocus()` is the guard (not `WorkbenchWindowService.activeWindow`,
 *  which pointerdown/focusin can set before the OS grants focus): requesting OS
 *  focus for an already-focused window flashes always-on-top windows on Windows.
 *--------------------------------------------------------------------------------------------*/

import {
  Disposable,
  IWindowsService,
  createDecorator,
  type IEditorGroup,
  type ILogger,
} from '@universe-editor/platform'
import { IAuxiliaryWindowsService } from '../../../shared/ipc/auxiliaryWindowService.js'
import { IWorkbenchWindowService, type IWorkbenchWindow } from './workbenchWindowService.js'

export interface IWindowFocusService {
  readonly _serviceBrand: undefined

  focusWindow(win: IWorkbenchWindow): void
  focusGroup(group: IEditorGroup): void
  focusMainWindow(): void
}

export const IWindowFocusService = createDecorator<IWindowFocusService>('windowFocusService')

export class WindowFocusService extends Disposable implements IWindowFocusService {
  declare readonly _serviceBrand: undefined

  private _currentWindowId: Promise<number> | undefined
  private readonly _pending = new Set<IWorkbenchWindow>()

  constructor(
    private readonly _workbenchWindows: IWorkbenchWindowService,
    private readonly _windows: IWindowsService,
    private readonly _aux: IAuxiliaryWindowsService,
    private readonly _logger?: ILogger,
  ) {
    super()
  }

  focusWindow(win: IWorkbenchWindow): void {
    // Keep overlay/dialog ownership in sync even when the native focus call is
    // skipped because the document already has focus.
    this._workbenchWindows.setActiveWindow(win)
    // Overlapping reveal paths (and focusPart's view recursion) can request the
    // same window several times in one turn; one in-flight request is enough
    // until it settles, when a genuinely needed retry still goes through.
    if (this._pending.has(win) || hasDocumentFocus(win)) return

    this._pending.add(win)
    const settle = (): void => {
      this._pending.delete(win)
    }
    if (win.isMain) {
      void this._windowId()
        .then((id) => this._windows.focusWindow(id))
        .catch((err: unknown) => {
          this._logger?.debug(`focus main window failed: ${String(err)}`)
        })
        .finally(settle)
      return
    }

    const token = win.token
    if (!token) {
      settle()
      return
    }
    void this._aux
      .focusWindow(token)
      .catch((err: unknown) => {
        this._logger?.debug(`focus auxiliary window ${win.id} failed: ${String(err)}`)
      })
      .finally(settle)
  }

  focusGroup(group: IEditorGroup): void {
    const win = this._workbenchWindows.getWindowForPart(group.part)
    if (win) this.focusWindow(win)
  }

  focusMainWindow(): void {
    this.focusWindow(this._workbenchWindows.mainWindow)
  }

  private _windowId(): Promise<number> {
    this._currentWindowId ??= this._windows.getCurrentWindowId().catch((err: unknown) => {
      this._currentWindowId = undefined
      throw err
    })
    return this._currentWindowId
  }
}

function hasDocumentFocus(win: IWorkbenchWindow): boolean {
  try {
    return win.document.hasFocus()
  } catch {
    return false
  }
}
