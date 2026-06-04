/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Thin adapter exposing WindowMainService over the cross-process IWindowsService
 *  wire: enumerate open windows, focus / open windows, and quit the app.
 *--------------------------------------------------------------------------------------------*/

import { app } from 'electron'
import {
  type Event,
  type IDisposable,
  type IOpenWindowInfo,
  type IWindowsService,
  URI,
  type UriComponents,
} from '@universe-editor/platform'
import type { WindowMainService } from './windowMainService.js'

export class MainWindowsService implements IWindowsService, IDisposable {
  declare readonly _serviceBrand: undefined

  constructor(
    private readonly _windows: WindowMainService,
    private readonly _isCurrentWindowFirst: boolean,
  ) {}

  get onDidChangeWindows(): Event<void> {
    return this._windows.onDidChangeWindows
  }

  getWindows(): Promise<readonly IOpenWindowInfo[]> {
    return Promise.resolve(this._windows.getOpenWindowInfos())
  }

  isCurrentWindowFirst(): Promise<boolean> {
    return Promise.resolve(this._isCurrentWindowFirst)
  }

  focusWindow(id: number): Promise<void> {
    this._windows.focusWindow(id)
    return Promise.resolve()
  }

  openWindow(folder?: URI | UriComponents): Promise<void> {
    const resolved = folder == null ? undefined : (URI.revive(folder) as URI)
    return this._windows.openWindowForFolder(resolved)
  }

  quit(): Promise<void> {
    app.quit()
    return Promise.resolve()
  }

  dispose(): void {
    // The underlying WindowMainService owns the emitter; nothing to release here.
  }
}
