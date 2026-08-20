/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Host service implementation operating on a specific BrowserWindow.
 *--------------------------------------------------------------------------------------------*/

import path from 'node:path'
import { spawn } from 'node:child_process'
import { spawnViaCmd } from '../process/cmdSpawn.js'
import { getAppVersion } from '../../appVersion.js'
import {
  app,
  clipboard,
  dialog,
  shell,
  nativeImage,
  nativeTheme,
  Notification,
  powerMonitor,
  type BrowserWindow,
} from 'electron'
import {
  Emitter,
  NullLogger,
  ShutdownReason,
  toDisposable,
  URI,
  type Event,
  type ExternalTerminalKind,
  type IClipboardImage,
  type ILogger,
  type IDisposable,
  type IHostServiceWire,
  type IOpenNewWindowOptions,
  type IShowOpenFileOptions,
  type IShowSaveFileOptions,
  type ISystemNotificationOptions,
  type ISystemNotificationResult,
  type IVersionInfo,
  type UriComponents,
} from '@universe-editor/platform'
import { version as EXTENSION_API_VERSION } from '@universe-editor/extension-api'
import { type IRendererLifecycleService } from '../../../shared/ipc/lifecycleService.js'
import { getMachineId } from './machineId.js'

/** Hooks letting restart consult the renderer veto chain. */
export interface RestartHooks {
  getRendererLifecycle?: () => IRendererLifecycleService | undefined
}

// Zoom level is Chromium's logarithmic step: each unit is a ~20% factor. Clamp to
// the range Electron's webFrame accepts so repeated presses can't run off-scale.
const ZOOM_STEP = 1
const ZOOM_MIN = -8
const ZOOM_MAX = 9

/** No system input for this long ⇒ the user isn't looking at the focused window,
 *  so the focus gate in notify() stops applying. Two minutes: long enough that
 *  reading code without touching the keyboard rarely trips it, short enough that
 *  stepping away doesn't swallow the next poll's toast (each new review only
 *  ever gets one notification chance — the rising edge is consumed either way). */
const USER_AWAY_IDLE_SECONDS = 120

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

// nativeTheme is process-global while host services are per-window: subscribing
// per window stacks one 'updated' listener per window and trips Node's
// MaxListenersExceededWarning past 10 windows. Share one upstream subscription
// and fan out to the per-window listeners (ref-counted so teardown is exact).
const nativeThemeUpdatedListeners = new Set<() => void>()
let nativeThemeSubscription: (() => void) | undefined

const dispatchNativeThemeUpdated = (): void => {
  for (const listener of nativeThemeUpdatedListeners) listener()
}

function subscribeNativeThemeUpdated(listener: () => void): IDisposable {
  if (!nativeThemeSubscription) {
    nativeTheme.on('updated', dispatchNativeThemeUpdated)
    nativeThemeSubscription = dispatchNativeThemeUpdated
  }
  nativeThemeUpdatedListeners.add(listener)
  return toDisposable(() => {
    nativeThemeUpdatedListeners.delete(listener)
    if (nativeThemeUpdatedListeners.size === 0 && nativeThemeSubscription) {
      nativeTheme.removeListener('updated', nativeThemeSubscription)
      nativeThemeSubscription = undefined
    }
  })
}

export class MainHostService implements IHostServiceWire, IDisposable {
  declare readonly _serviceBrand: undefined

  private readonly _onDidChangeMaximized = new Emitter<boolean>()
  readonly onDidChangeMaximized: Event<boolean> = this._onDidChangeMaximized.event

  private readonly _onMaximize = (): void => this._onDidChangeMaximized.fire(true)
  private readonly _onUnmaximize = (): void => this._onDidChangeMaximized.fire(false)

  private readonly _onDidChangeColorScheme = new Emitter<boolean>()
  readonly onDidChangeColorScheme: Event<boolean> = this._onDidChangeColorScheme.event

  // nativeTheme is process-global: every window's host service mirrors the same
  // OS scheme flips to its renderer (VSCode IHostColorSchemeService 的对等物）。
  private readonly _onNativeThemeUpdated = (): void =>
    this._onDidChangeColorScheme.fire(nativeTheme.shouldUseDarkColors)
  private readonly _nativeThemeSubscription = subscribeNativeThemeUpdated(
    this._onNativeThemeUpdated,
  )

  constructor(
    private readonly _win: BrowserWindow,
    private readonly _createNewWindow: (options?: IOpenNewWindowOptions) => void = () => {},
    private readonly _logger: ILogger = new NullLogger(),
    private readonly _restartHooks?: RestartHooks,
  ) {
    _win.on('maximize', this._onMaximize)
    _win.on('unmaximize', this._onUnmaximize)
  }

  isDarkColorScheme(): Promise<boolean> {
    return Promise.resolve(nativeTheme.shouldUseDarkColors)
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

  openNewWindow(options?: IOpenNewWindowOptions): Promise<void> {
    this._createNewWindow(options)
    this._logger.info(`openNewWindow requestedBy=${this._win.id}`)
    return Promise.resolve()
  }

  async showOpenFileDialog(opts?: IShowOpenFileOptions): Promise<UriComponents[] | null> {
    const properties: Array<'openFile' | 'openDirectory' | 'multiSelections'> = []
    if (opts?.canSelectFiles !== false) properties.push('openFile')
    if (opts?.canSelectFolders === true) properties.push('openDirectory')
    if (opts?.canSelectMany === true) properties.push('multiSelections')
    if (properties.length === 0) properties.push('openFile')
    const result = await dialog.showOpenDialog(this._win, {
      properties,
      ...(opts?.title !== undefined ? { title: opts.title } : {}),
      ...(opts?.defaultPath !== undefined ? { defaultPath: path.normalize(opts.defaultPath) } : {}),
      ...(opts?.buttonLabel !== undefined ? { buttonLabel: opts.buttonLabel } : {}),
      ...(opts?.filters !== undefined
        ? {
            filters: opts.filters.map((f) => ({ name: f.name, extensions: [...f.extensions] })),
          }
        : {}),
    })
    if (result.canceled || result.filePaths.length === 0) {
      this._logger.info(`showOpenFileDialog cancelled id=${this._win.id}`)
      return null
    }
    this._logger.info(`showOpenFileDialog picked ${result.filePaths.join(', ')}`)
    return result.filePaths.map((p) => URI.file(p).toJSON())
  }

  async showSaveFileDialog(opts?: IShowSaveFileOptions): Promise<UriComponents | null> {
    const result = await dialog.showSaveDialog(this._win, {
      ...(opts?.title !== undefined ? { title: opts.title } : {}),
      ...(opts?.defaultPath !== undefined ? { defaultPath: path.normalize(opts.defaultPath) } : {}),
      ...(opts?.buttonLabel !== undefined ? { buttonLabel: opts.buttonLabel } : {}),
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

  openInVSCode(fsPath: string, remoteAuthority?: string): Promise<string> {
    // `code` is a shell launcher (code.cmd on Windows), so wrap it in cmd.exe to
    // resolve it from PATH (not `shell: true` — its unescaped args trip DEP0190).
    // Detach so VS Code outlives the spawning child.
    const args = remoteAuthority ? ['--remote', remoteAuthority, fsPath] : [fsPath]
    return new Promise<string>((resolve) => {
      const child = spawnViaCmd('code', args, {
        detached: true,
        stdio: 'ignore',
      })
      child.on('error', (err) => {
        this._logger.error(`openInVSCode failed ${fsPath}`, err)
        resolve(err.message)
      })
      child.on('spawn', () => {
        child.unref()
        this._logger.info(
          remoteAuthority
            ? `openInVSCode ${fsPath} remote=${remoteAuthority}`
            : `openInVSCode ${fsPath}`,
        )
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
    if (gated && !this._win.isDestroyed() && this._win.isFocused() && !this._isUserAway()) {
      // info, not debug: this branch swallowing a toast is exactly what field
      // diagnosis needs to see in host.log (the overnight bug was proven by the
      // ABSENCE of "notify shown" lines — make the decision explicit instead).
      this._logger.info(`notify skipped (window focused, user present) title=${opts.title}`)
      return Promise.resolve({ shown: false, clicked: false })
    }
    if (!Notification.isSupported()) {
      this._logger.info('notify skipped (notifications unsupported)')
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

  /** Focus alone cannot gate the toast: Windows keeps the last foreground window
   *  "focused" after the user locks the screen or walks away, which silently
   *  swallowed every overnight Swarm-review notification (the toast was gated at
   *  00:07 with nobody at the machine). locked / idle-past-threshold ⇒ away;
   *  'unknown' (or a platform without the API) conservatively counts as present. */
  private _isUserAway(): boolean {
    // E2E must stay deterministic: an unattended CI runner is always idle, which
    // would flip every focused-window notification spec onto the OS-toast path.
    // Freeze to "present" there; UNIVERSE_E2E_REAL_IDLE=1 opts back into the probe.
    if (process.env['UNIVERSE_E2E'] === '1' && !process.env['UNIVERSE_E2E_REAL_IDLE']) return false
    try {
      const state = powerMonitor.getSystemIdleState(USER_AWAY_IDLE_SECONDS)
      return state === 'locked' || state === 'idle'
    } catch {
      return false
    }
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

  async getVersionInfo(): Promise<IVersionInfo> {
    return {
      productName: app.getName(),
      version: getAppVersion(),
      extensionApi: EXTENSION_API_VERSION,
      electron: process.versions.electron,
      node: process.versions.node,
      chromium: process.versions.chrome,
      v8: process.versions.v8,
      machineId: await getMachineId(app.getPath('userData')),
      appRoot: app.getAppPath(),
    }
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
    this._nativeThemeSubscription.dispose()
    this._onDidChangeMaximized.dispose()
    this._onDidChangeColorScheme.dispose()
  }
}
