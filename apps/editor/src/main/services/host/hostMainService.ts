/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Host service implementation operating on a specific BrowserWindow.
 *--------------------------------------------------------------------------------------------*/

import { dialog, shell, type BrowserWindow } from 'electron'
import {
  Emitter,
  URI,
  type Event,
  type IDisposable,
  type IHostServiceWire,
  type IShowOpenFileOptions,
  type IShowSaveFileOptions,
  type UriComponents,
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

  async showOpenFileDialog(opts?: IShowOpenFileOptions): Promise<UriComponents | null> {
    const result = await dialog.showOpenDialog(this._win, {
      properties: ['openFile'],
      ...(opts?.title !== undefined ? { title: opts.title } : {}),
      ...(opts?.defaultPath !== undefined ? { defaultPath: opts.defaultPath } : {}),
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const picked = result.filePaths[0]
    if (!picked) return null
    return URI.file(picked).toJSON()
  }

  async showSaveFileDialog(opts?: IShowSaveFileOptions): Promise<UriComponents | null> {
    const result = await dialog.showSaveDialog(this._win, {
      ...(opts?.title !== undefined ? { title: opts.title } : {}),
      ...(opts?.defaultPath !== undefined ? { defaultPath: opts.defaultPath } : {}),
    })
    if (result.canceled || !result.filePath) return null
    return URI.file(result.filePath).toJSON()
  }

  showItemInFolder(fsPath: string): Promise<void> {
    shell.showItemInFolder(fsPath)
    return Promise.resolve()
  }

  openWithDefaultApp(path: string): Promise<string> {
    return shell.openPath(path)
  }

  dispose(): void {
    if (!this._win.isDestroyed()) {
      this._win.removeListener('maximize', this._onMaximize)
      this._win.removeListener('unmaximize', this._onUnmaximize)
    }
    this._onDidChangeMaximized.dispose()
  }
}
