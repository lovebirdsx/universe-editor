/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Host service implementation operating on a specific BrowserWindow.
 *--------------------------------------------------------------------------------------------*/

import { app, dialog, shell, type BrowserWindow } from 'electron'
import {
  Emitter,
  NullLogger,
  URI,
  type Event,
  type ILogger,
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

  constructor(
    private readonly _win: BrowserWindow,
    private readonly _createNewWindow: () => void = () => {},
    private readonly _logger: ILogger = new NullLogger(),
  ) {
    _win.on('maximize', this._onMaximize)
    _win.on('unmaximize', this._onUnmaximize)
  }

  isMaximized(): Promise<boolean> {
    return Promise.resolve(this._win.isMaximized())
  }

  minimizeWindow(): Promise<void> {
    this._win.minimize()
    this._logger.debug(`minimizeWindow id=${this._win.id}`)
    return Promise.resolve()
  }

  toggleMaximizeWindow(): Promise<void> {
    if (this._win.isMaximized()) {
      this._win.unmaximize()
      this._logger.debug(`unmaximizeWindow id=${this._win.id}`)
    } else {
      this._win.maximize()
      this._logger.debug(`maximizeWindow id=${this._win.id}`)
    }
    return Promise.resolve()
  }

  closeWindow(): Promise<void> {
    this._win.close()
    this._logger.info(`closeWindow id=${this._win.id}`)
    return Promise.resolve()
  }

  restart(): Promise<void> {
    // Under `electron-vite dev`, reloading the current window keeps the app
    // attached to the live Vite dev server instead of relaunching a detached
    // Electron process with no managed renderer.
    if (process.env['ELECTRON_RENDERER_URL']) {
      this._win.reload()
      this._logger.info(`restart reloadWindow id=${this._win.id}`)
      return Promise.resolve()
    }

    this._logger.info('restart relaunchApp')
    app.relaunch()
    app.quit()
    return Promise.resolve()
  }

  toggleDevTools(): Promise<void> {
    if (!this._win.isDestroyed()) {
      this._win.webContents.toggleDevTools()
      this._logger.debug(`toggleDevTools id=${this._win.id}`)
    }
    return Promise.resolve()
  }

  openNewWindow(): Promise<void> {
    this._createNewWindow()
    this._logger.info(`openNewWindow requestedBy=${this._win.id}`)
    return Promise.resolve()
  }

  async showOpenFileDialog(opts?: IShowOpenFileOptions): Promise<UriComponents | null> {
    const result = await dialog.showOpenDialog(this._win, {
      properties: ['openFile'],
      ...(opts?.title !== undefined ? { title: opts.title } : {}),
      ...(opts?.defaultPath !== undefined ? { defaultPath: opts.defaultPath } : {}),
    })
    if (result.canceled || result.filePaths.length === 0) {
      this._logger.info(`showOpenFileDialog cancelled id=${this._win.id}`)
      return null
    }
    const picked = result.filePaths[0]
    if (!picked) return null
    this._logger.info(`showOpenFileDialog picked ${picked}`)
    return URI.file(picked).toJSON()
  }

  async showSaveFileDialog(opts?: IShowSaveFileOptions): Promise<UriComponents | null> {
    const result = await dialog.showSaveDialog(this._win, {
      ...(opts?.title !== undefined ? { title: opts.title } : {}),
      ...(opts?.defaultPath !== undefined ? { defaultPath: opts.defaultPath } : {}),
    })
    if (result.canceled || !result.filePath) {
      this._logger.info(`showSaveFileDialog cancelled id=${this._win.id}`)
      return null
    }
    this._logger.info(`showSaveFileDialog picked ${result.filePath}`)
    return URI.file(result.filePath).toJSON()
  }

  showItemInFolder(fsPath: string): Promise<void> {
    shell.showItemInFolder(fsPath)
    this._logger.info(`showItemInFolder ${fsPath}`)
    return Promise.resolve()
  }

  openWithDefaultApp(path: string): Promise<string> {
    this._logger.info(`openWithDefaultApp ${path}`)
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
