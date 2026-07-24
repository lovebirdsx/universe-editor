/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Host service implementation operating on a specific BrowserWindow.
 *--------------------------------------------------------------------------------------------*/

import path from 'node:path'
import { spawn } from 'node:child_process'
import {
  app,
  clipboard,
  dialog,
  shell,
  nativeImage,
  Notification,
  type BrowserWindow,
} from 'electron'
import {
  Emitter,
  NullLogger,
  ShutdownReason,
  URI,
  type Event,
  type ExternalTerminalKind,
  type IClipboardImage,
  type ILogger,
  type IDisposable,
  type IHostServiceWire,
  type IShowOpenFileOptions,
  type IShowSaveFileOptions,
  type ISystemNotificationOptions,
  type ISystemNotificationResult,
  type IVersionInfo,
  type UriComponents,
} from '@universe-editor/platform'
import { type IRendererLifecycleService } from '../../../shared/ipc/lifecycleService.js'

/** Hooks letting restart consult the renderer veto chain. */
export interface RestartHooks {
  getRendererLifecycle?: () => IRendererLifecycleService | undefined
}

// Zoom level is Chromium's logarithmic step: each unit is a ~20% factor. Clamp to
// the range Electron's webFrame accepts so repeated presses can't run off-scale.
const ZOOM_STEP = 1
const ZOOM_MIN = -8
const ZOOM_MAX = 9

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

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
    private readonly _restartHooks?: RestartHooks,
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

  async restart(): Promise<void> {
    const rendererLifecycle = this._restartHooks?.getRendererLifecycle?.()
    if (rendererLifecycle) {
      let canProceed = true
      try {
        canProceed = await rendererLifecycle.confirmShutdown(ShutdownReason.Reload)
      } catch {
        canProceed = true
      }
      if (!canProceed) {
        this._logger.info(`restart vetoed by renderer id=${this._win.id}`)
        return
      }
    }
    this._win.reload()
    this._logger.info(`restart reloadWindow id=${this._win.id}`)
  }

  toggleDevTools(): Promise<void> {
    if (!this._win.isDestroyed()) {
      this._win.webContents.toggleDevTools()
      this._logger.debug(`toggleDevTools id=${this._win.id}`)
    }
    return Promise.resolve()
  }

  zoomIn(): Promise<void> {
    return this._applyZoom((level) => level + ZOOM_STEP)
  }

  zoomOut(): Promise<void> {
    return this._applyZoom((level) => level - ZOOM_STEP)
  }

  resetZoom(): Promise<void> {
    return this._applyZoom(() => 0)
  }

  private _applyZoom(next: (current: number) => number): Promise<void> {
    if (!this._win.isDestroyed()) {
      const wc = this._win.webContents
      const level = clamp(next(wc.getZoomLevel()), ZOOM_MIN, ZOOM_MAX)
      wc.setZoomLevel(level)
      this._logger.debug(`setZoomLevel ${level} id=${this._win.id}`)
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
      ...(opts?.defaultPath !== undefined ? { defaultPath: path.normalize(opts.defaultPath) } : {}),
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
      ...(opts?.defaultPath !== undefined ? { defaultPath: path.normalize(opts.defaultPath) } : {}),
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

  async openUserDataFolder(): Promise<void> {
    const dir = app.getPath('userData')
    const error = await shell.openPath(dir)
    if (error) throw new Error(error)
  }

  openInstallFolder(): Promise<void> {
    const exe = app.getPath('exe')
    shell.showItemInFolder(exe)
    this._logger.info(`openInstallFolder ${exe}`)
    return Promise.resolve()
  }

  openInVSCode(fsPath: string): Promise<string> {
    // `code` is a shell launcher (code.cmd on Windows), so go through the shell
    // to resolve it from PATH. Detach so VS Code outlives the spawning child.
    return new Promise<string>((resolve) => {
      const child = spawn('code', [fsPath], {
        shell: true,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
      child.on('error', (err) => {
        this._logger.error(`openInVSCode failed ${fsPath}`, err)
        resolve(err.message)
      })
      child.on('spawn', () => {
        child.unref()
        this._logger.info(`openInVSCode ${fsPath}`)
        resolve('')
      })
    })
  }

  openTerminal(cwd: string, kind: ExternalTerminalKind = 'powershell'): Promise<void> {
    try {
      if (process.platform === 'win32') {
        // Build a single cmd.exe command line; rely on `start` to spawn an
        // independent console window. `windowsVerbatimArguments: true` is
        // required so Node doesn't re-escape `""` (the empty title) or our
        // pre-quoted cwd — matches VSCode's externalTerminalService.
        const quotedCwd = `"${cwd.replace(/"/g, '""')}"`
        const exec =
          kind === 'wt'
            ? `wt.exe -d ${quotedCwd}`
            : kind === 'powershell'
              ? 'powershell.exe'
              : kind === 'pwsh'
                ? 'pwsh.exe'
                : 'cmd.exe'
        const command = `start "" /D ${quotedCwd} ${exec}`
        const child = spawn('cmd.exe', ['/c', command], {
          cwd,
          windowsVerbatimArguments: true,
          windowsHide: true,
        })
        child.on('error', (err) => this._logger.error(`openTerminal (win32, ${kind}) failed`, err))
        child.on('exit', (code) => {
          if (code !== 0) {
            this._logger.warn(`openTerminal (win32, ${kind}) cmd exited code=${code}`)
          }
        })
      } else if (process.platform === 'darwin') {
        const child = spawn('open', ['-a', 'Terminal', cwd], { detached: true, stdio: 'ignore' })
        child.on('error', (err) => this._logger.error('openTerminal (darwin) failed', err))
        child.unref()
      } else {
        const child = spawn('x-terminal-emulator', [], { cwd, detached: true, stdio: 'ignore' })
        child.on('error', () => {
          const fallback = spawn('xterm', [], { cwd, detached: true, stdio: 'ignore' })
          fallback.on('error', (err) =>
            this._logger.error('openTerminal (linux) fallback failed', err),
          )
          fallback.unref()
        })
        child.unref()
      }
      this._logger.info(`openTerminal cwd=${cwd} kind=${kind}`)
    } catch (err) {
      this._logger.error('openTerminal failed', err)
      throw err
    }
    return Promise.resolve()
  }

  notify(opts: ISystemNotificationOptions): Promise<ISystemNotificationResult> {
    const gated = opts.onlyWhenBlurred !== false
    if (gated && !this._win.isDestroyed() && this._win.isFocused()) {
      this._logger.debug(`notify skipped (window focused) title=${opts.title}`)
      return Promise.resolve({ shown: false, clicked: false })
    }
    if (!Notification.isSupported()) {
      this._logger.debug('notify skipped (notifications unsupported)')
      return Promise.resolve({ shown: false, clicked: false })
    }

    const icon = opts.icon !== undefined ? nativeImage.createFromDataURL(opts.icon) : undefined
    const notification = new Notification({
      title: opts.title,
      body: opts.body,
      ...(icon && !icon.isEmpty() ? { icon } : {}),
    })
    this._requestAttention()
    this._logger.info(`notify shown title=${opts.title}`)

    return new Promise<ISystemNotificationResult>((resolve) => {
      let settled = false
      const settle = (clicked: boolean): void => {
        if (settled) return
        settled = true
        resolve({ shown: true, clicked })
      }
      notification.on('click', () => {
        // Focus synchronously inside the click handler so the window comes
        // forward within the OS-granted input grace window — a renderer
        // round-trip would step outside it and Windows would refuse foreground.
        this.focusWindow()
        settle(true)
      })
      notification.on('close', () => settle(false))
      notification.on('failed', () => {
        if (settled) return
        settled = true
        resolve({ shown: false, clicked: false })
      })
      notification.show()
    })
  }

  focusWindow(): Promise<void> {
    if (this._win.isDestroyed()) return Promise.resolve()
    this._clearAttention()
    if (this._win.isMinimized()) this._win.restore()
    if (process.platform === 'win32') {
      // Toggle always-on-top to defeat Windows' SetForegroundWindow lock —
      // a plain focus() is silently ignored when another process owns the
      // foreground, leaving the window flashing in the taskbar instead.
      this._win.setAlwaysOnTop(true)
      this._win.show()
      this._win.focus()
      this._win.moveTop()
      this._win.setAlwaysOnTop(false)
    } else {
      this._win.show()
      this._win.focus()
    }
    this._logger.debug(`focusWindow id=${this._win.id}`)
    return Promise.resolve()
  }

  readClipboardImage(): Promise<IClipboardImage | null> {
    const image = clipboard.readImage()
    if (image.isEmpty()) {
      this._logger.debug('readClipboardImage: clipboard holds no image')
      return Promise.resolve(null)
    }
    const png = image.toPNG()
    if (png.length === 0) {
      this._logger.debug('readClipboardImage: PNG encode produced no bytes')
      return Promise.resolve(null)
    }
    this._logger.debug(`readClipboardImage: ${png.length} bytes`)
    return Promise.resolve({
      dataBase64: png.toString('base64'),
      mimeType: 'image/png',
      byteSize: png.length,
    })
  }

  writeClipboardImage(dataBase64: string): Promise<void> {
    const image = nativeImage.createFromBuffer(Buffer.from(dataBase64, 'base64'))
    if (image.isEmpty()) {
      this._logger.debug('writeClipboardImage: decoded image is empty, skipping')
      return Promise.resolve()
    }
    clipboard.writeImage(image)
    this._logger.debug(
      `writeClipboardImage: wrote ${image.getSize().width}x${image.getSize().height}`,
    )
    return Promise.resolve()
  }

  getVersionInfo(): Promise<IVersionInfo> {
    return Promise.resolve({
      productName: app.getName(),
      version: app.getVersion(),
      electron: process.versions.electron,
      node: process.versions.node,
      chromium: process.versions.chrome,
      v8: process.versions.v8,
    })
  }

  private _requestAttention(): void {
    if (this._win.isDestroyed()) return
    if (process.platform === 'darwin') {
      app.dock?.bounce('informational')
    } else {
      this._win.flashFrame(true)
    }
  }

  private _clearAttention(): void {
    if (this._win.isDestroyed()) return
    if (process.platform !== 'darwin') {
      this._win.flashFrame(false)
    }
  }

  dispose(): void {
    if (!this._win.isDestroyed()) {
      this._win.removeListener('maximize', this._onMaximize)
      this._win.removeListener('unmaximize', this._onUnmaximize)
    }
    this._onDidChangeMaximized.dispose()
  }
}
