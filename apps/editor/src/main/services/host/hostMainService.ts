/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Host service implementation operating on a specific BrowserWindow.
 *--------------------------------------------------------------------------------------------*/

import { type BrowserWindow } from 'electron'
import {
  Emitter,
  type Event,
  type IDisposable,
  type IHostServiceWire,
} from '@universe-editor/platform'

export class MainHostService implements IHostServiceWire, IDisposable {
  declare readonly _serviceBrand: undefined

  private readonly _onDidChangeMaximized = new Emitter<boolean>()
  readonly onDidChangeMaximized: Event<boolean> = this._onDidChangeMaximized.event

  private readonly _onMaximize = (): void => this._onDidChangeMaximized.fire(true)
  private readonly _onUnmaximize = (): void => this._onDidChangeMaximized.fire(false)

  constructor(private readonly _win: BrowserWindow) {
    _win.on('maximize', this._onMaximize)
    _win.on('unmaximize', this._onUnmaximize)
  }

  isMaximized(): Promise<boolean> {
    return Promise.resolve(this._win.isMaximized())
  }

  minimizeWindow(): Promise<void> {
    this._win.minimize()
    return Promise.resolve()
  }

  toggleMaximizeWindow(): Promise<void> {
    if (this._win.isMaximized()) {
      this._win.unmaximize()
    } else {
      this._win.maximize()
    }
    return Promise.resolve()
  }

  closeWindow(): Promise<void> {
    this._win.close()
    return Promise.resolve()
  }

  toggleDevTools(): Promise<void> {
    if (!this._win.isDestroyed()) {
      this._win.webContents.toggleDevTools()
    }
    return Promise.resolve()
  }

  dispose(): void {
    if (!this._win.isDestroyed()) {
      this._win.removeListener('maximize', this._onMaximize)
      this._win.removeListener('unmaximize', this._onUnmaximize)
    }
    this._onDidChangeMaximized.dispose()
  }
}
