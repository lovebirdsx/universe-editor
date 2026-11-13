/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  BackgroundModeMainService: owns the tray and the "keep running in the
 *  background" decision. It never touches BrowserWindows directly — a narrow
 *  window interface keeps the window service free of this service (the two are
 *  constructed in a fixed order) and every decision unit-testable with fakes.
 *--------------------------------------------------------------------------------------------*/

import {
  app,
  Menu,
  nativeImage,
  powerMonitor,
  Tray,
  type MenuItemConstructorOptions,
  type NativeImage,
} from 'electron'
import { readFileSync } from 'node:fs'
import {
  DisposableStore,
  localize,
  type Event,
  type IDisposable,
  type ILogger,
} from '@universe-editor/platform'
import type {
  MobileGatewayConfig,
  MobileGatewayConfigState,
  MobileGatewayState,
  MobileGatewayStatus,
} from '../../../shared/ipc/mobileGatewayService.js'
import {
  gatewayEnvironmentFromProcess,
  isMobileGatewayEnabled,
} from '../mobileGateway/gatewayConfig.js'
import {
  BACKGROUND_IDLE_RECLAIM_MS,
  BACKGROUND_IDLE_SCAN_INTERVAL_MS,
  decideActivateAction,
  decidePrimaryWindowAction,
  isBackgroundModeActive,
  supportsLoginItem,
  updateIdleState,
  type IdleWindowCandidate,
} from './backgroundModePolicy.js'

/** Minimum gap between two "show" actions from repeated tray clicks. */
export const TRAY_CLICK_DEBOUNCE_MS = 400

/** Narrow window surface; the real implementation is WindowMainService. */
export interface BackgroundModeWindows {
  getHiddenWindowInfos(): readonly { id: number; name: string; hiddenSeq: number }[]
  getWindowCount(): number
  getVisibleWindowCount(): number
  revealWindow(id: number): void
  revealAllHiddenWindows(): void
  focusWindow(id: number): void
  getFocusedWindowId(): number | null
  closeWindowWithoutVeto(id: number): void
}

/** Narrow gateway surface; the real implementation is MobileGatewayMainService. */
export interface BackgroundModeGateway {
  getConfig(): Promise<MobileGatewayConfigState>
  readonly onDidChangeConfig: Event<MobileGatewayConfigState>
  getStatus(): Promise<MobileGatewayStatus>
  readonly onDidChangeStatus: Event<MobileGatewayStatus>
}

/** Subset of Electron's Tray used here, so tests can inject a plain fake. */
export interface BackgroundModeTray {
  setToolTip(text: string): void
  popUpContextMenu(menu: unknown): void
  destroy(): void
  on(event: 'click' | 'right-click', listener: () => void): unknown
}

export interface BackgroundModeMainServiceOptions {
  readonly windows: BackgroundModeWindows
  readonly gateway: BackgroundModeGateway
  /** Restore the persisted multi-window session (no window exists). */
  readonly restoreSession: () => Promise<void>
  /** Open a fresh empty window (a visible window already exists). */
  readonly createWindow: () => Promise<unknown>
  readonly logger: ILogger
  /** E2E drives the mode through the main-process probe; a missing tray must not disable it. */
  readonly e2eEnabled: boolean
  readonly platform: NodeJS.Platform
  /** Login items only exist in installed builds. */
  readonly isPackaged: boolean
  /** Test seam; defaults to Electron's `app.setLoginItemSettings`. */
  readonly setLoginItem?: (settings: { openAtLogin: boolean; args?: string[] }) => void
  /** Optional OS-state read; lets startup skip a redundant login-item write. */
  readonly getLoginItemOpenAtLogin?: () => boolean
  /** Absolute `icon.ico` path (dev: apps/editor/public, packaged: resources/tray). */
  readonly trayIconPath: string
  /** Test seam; production constructs a real Electron Tray. */
  readonly createTray?: (image: NativeImage) => BackgroundModeTray
  /** Test seam / late-bound quit; defaults to `app.quit()`. */
  readonly quit?: () => void
  /** Live per-window session counts; a hidden window with work must never be reclaimed. */
  readonly sessionCounts: (windowId: number) => { readonly running: number; readonly ask: number }
  /** Whether a phone is currently subscribed to one of the window's sessions. */
  readonly hasSessionSubscribers: (windowId: number) => boolean
  /** Test seam; defaults to {@link BACKGROUND_IDLE_RECLAIM_MS}. */
  readonly idleReclaimAfterMs?: number
  /** Test seam; defaults to {@link BACKGROUND_IDLE_SCAN_INTERVAL_MS}. */
  readonly idleScanIntervalMs?: number
  /** Test seam; defaults to Electron's `powerMonitor`. */
  readonly onSystemResume?: (listener: () => void) => IDisposable
}

export interface TrayMenuWindow {
  readonly id: number
  readonly name: string
}

export interface TrayMenuGateway {
  readonly state: MobileGatewayState
  readonly listenAddress?: string
}

export interface TrayMenuActions {
  showPrimary(): void
  revealWindow(id: number): void
  exit(): void
}

export interface TrayMenuInput {
  readonly hiddenWindows: readonly TrayMenuWindow[]
  readonly gateway: TrayMenuGateway
  readonly actions: TrayMenuActions
}

/** Electron-compatible menu item shape, kept platform-free for tests. */
export interface TrayMenuItem {
  readonly label?: string
  readonly enabled?: boolean
  readonly type?: 'normal' | 'separator'
  readonly click?: () => void
  readonly submenu?: readonly TrayMenuItem[]
}

/** Pure menu template: the tray rebuilds it on every right-click with live state. */
export function buildTrayMenuTemplate(input: TrayMenuInput): TrayMenuItem[] {
  const hiddenItems: TrayMenuItem[] =
    input.hiddenWindows.length === 0
      ? [
          {
            label: localize('tray.noHiddenWindows', 'No hidden windows'),
            enabled: false,
          },
        ]
      : input.hiddenWindows.map((window) => ({
          label: window.name,
          click: () => input.actions.revealWindow(window.id),
        }))

  return [
    {
      label: localize('tray.show', 'Show Universe Editor'),
      click: () => input.actions.showPrimary(),
    },
    {
      label: localize('tray.hiddenWindows', 'Hidden Windows'),
      submenu: hiddenItems,
    },
    { type: 'separator' },
    { label: gatewayStatusLabel(input.gateway), enabled: false },
    { type: 'separator' },
    {
      label: localize('tray.exit', 'Exit'),
      click: () => input.actions.exit(),
    },
  ]
}

function gatewayStatusLabel(gateway: TrayMenuGateway): string {
  switch (gateway.state) {
    case 'running':
      return gateway.listenAddress !== undefined
        ? localize('tray.gateway.running', 'Phone gateway: running ({address})', {
            address: gateway.listenAddress,
          })
        : localize('tray.gateway.runningNoAddress', 'Phone gateway: running')
    case 'starting':
      return localize('tray.gateway.starting', 'Phone gateway: starting…')
    case 'error':
      return localize('tray.gateway.error', 'Phone gateway: error')
    default:
      return localize('tray.gateway.stopped', 'Phone gateway: stopped')
  }
}

function defaultCreateTray(image: NativeImage): BackgroundModeTray {
  return new Tray(image) as unknown as BackgroundModeTray
}

function defaultOnSystemResume(listener: () => void): IDisposable {
  powerMonitor.on('resume', listener)
  return { dispose: () => powerMonitor.removeListener('resume', listener) }
}

function defaultSetLoginItem(settings: { openAtLogin: boolean; args?: string[] }): void {
  app.setLoginItemSettings(settings)
}

/**
 * Extract the largest PNG-compressed image from an ICO file. Electron's
 * `nativeImage.createFromPath` handles ICO only on Windows, so macOS/Linux get
 * the embedded 256×256 PNG and resize it themselves. Pure, so the parsing is
 * unit-testable without an Electron runtime.
 */
export function extractPngFromIco(buffer: Buffer): Buffer | undefined {
  if (buffer.length < 6) return undefined
  // ICONDIR: reserved(2) type(2) count(2); type 1 = icon.
  if (buffer.readUInt16LE(0) !== 0 || buffer.readUInt16LE(2) !== 1) return undefined
  const count = buffer.readUInt16LE(4)
  const directoryEnd = 6 + count * 16
  if (count === 0 || directoryEnd > buffer.length) return undefined

  let best: { width: number; offset: number; size: number } | undefined
  for (let index = 0; index < count; index++) {
    const entry = 6 + index * 16
    // 0 means 256 pixels in an ICO directory entry.
    const width = buffer.readUInt8(entry) === 0 ? 256 : buffer.readUInt8(entry)
    const size = buffer.readUInt32LE(entry + 8)
    const offset = buffer.readUInt32LE(entry + 12)
    if (size === 0 || offset + size > buffer.length) continue
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    if (
      buffer[offset] !== 0x89 ||
      buffer[offset + 1] !== 0x50 ||
      buffer[offset + 2] !== 0x4e ||
      buffer[offset + 3] !== 0x47
    ) {
      continue
    }
    if (best === undefined || width > best.width) best = { width, offset, size }
  }
  if (best === undefined) return undefined
  return Buffer.from(buffer.subarray(best.offset, best.offset + best.size))
}

export class BackgroundModeMainService {
  private readonly _disposables = new DisposableStore()
  private readonly _logger: ILogger
  private _tray: BackgroundModeTray | undefined
  private _clickTimer: ReturnType<typeof setTimeout> | undefined
  private _desiredActive = false
  private _trayFailed = false
  private _started = false
  private _disposed = false
  private _gatewayStatus: MobileGatewayStatus | undefined
  private _idleSince = new Map<number, number>()
  private _idleTimer: ReturnType<typeof setInterval> | undefined
  private _readyResolved = false
  private _lastLoginItemOpenAtLogin: boolean | undefined
  private _loginItemStateRead = false
  private readonly _ready: Promise<void>
  private _resolveReady!: () => void

  constructor(private readonly _opts: BackgroundModeMainServiceOptions) {
    this._logger = _opts.logger
    this._ready = new Promise<void>((resolve) => {
      this._resolveReady = resolve
    })
  }

  /** Starts the first config read exactly once; resolves after the first apply. */
  initialize(): Promise<void> {
    if (!this._started) {
      this._started = true
      void this._initialize()
    }
    return this._ready
  }

  whenReady(): Promise<void> {
    return this._ready
  }

  /** Config says background mode is on AND the tray is actually usable. */
  isActive(): boolean {
    if (!this._desiredActive) return false
    if (this._opts.e2eEnabled) return true
    return this._tray !== undefined
  }

  /** Production without a tray must not hide every window into an invisible process. */
  shouldHideOnClose(): boolean {
    return this.isActive()
  }

  async showPrimaryWindow(): Promise<void> {
    const action = decidePrimaryWindowAction({
      hidden: this._hiddenWindowInfos(),
      liveWindowCount: this._opts.windows.getWindowCount(),
    })
    this._logger.info(`background show primary action=${action.kind}`)
    switch (action.kind) {
      case 'show-hidden':
        this._opts.windows.focusWindow(action.windowId)
        return
      case 'restore':
        await this._opts.restoreSession()
        return
      case 'create':
        await this._opts.createWindow()
        return
    }
  }

  async handleActivate(): Promise<void> {
    const action = decideActivateAction({
      hidden: this._hiddenWindowInfos(),
      liveWindowCount: this._opts.windows.getWindowCount(),
    })
    this._logger.info(`background activate action=${action.kind}`)
    switch (action.kind) {
      case 'show-hidden':
        this._opts.windows.focusWindow(action.windowId)
        return
      case 'restore':
        await this._opts.restoreSession()
        return
      case 'focus': {
        const focused = this._opts.windows.getFocusedWindowId()
        if (focused !== null) this._opts.windows.focusWindow(focused)
        return
      }
    }
  }

  /** Only asks the app to quit; before-quit owns the running-session confirmation. */
  exit(): void {
    this._logger.info('background exit requested')
    if (this._opts.quit) this._opts.quit()
    else app.quit()
  }

  dispose(): void {
    if (this._disposed) return
    this._disposed = true
    this._stopIdleScan()
    if (this._clickTimer !== undefined) {
      clearTimeout(this._clickTimer)
      this._clickTimer = undefined
    }
    this._tray?.destroy()
    this._tray = undefined
    this._disposables.dispose()
    this._resolveReadyOnce()
  }

  private async _initialize(): Promise<void> {
    try {
      const onSystemResume = this._opts.onSystemResume ?? defaultOnSystemResume
      this._disposables.add(
        onSystemResume(() => {
          // Sleeping for a long time must not count as idle time; otherwise the
          // first scan after wake would reclaim every hidden window at once.
          this._idleSince.clear()
          this._logger.info('background idle timer reset after system resume')
        }),
      )
      this._disposables.add(
        this._opts.gateway.onDidChangeConfig((state) => {
          void this._applyConfig(state.config).catch((err: unknown) => {
            this._logger.warn(`background mode config apply failed: ${String(err)}`)
          })
        }),
      )
      this._disposables.add(
        this._opts.gateway.onDidChangeStatus((status) => {
          this._gatewayStatus = status
        }),
      )
      const [configState, status] = await Promise.all([
        this._opts.gateway.getConfig(),
        this._opts.gateway.getStatus().catch(() => undefined),
      ])
      this._gatewayStatus = status
      await this._applyConfig(configState.config)
    } catch (err) {
      this._logger.warn(`background mode initialization failed: ${String(err)}`)
    } finally {
      this._resolveReadyOnce()
    }
  }

  private async _applyConfig(config: MobileGatewayConfig): Promise<void> {
    if (this._disposed) return
    const gatewayEnabled = isMobileGatewayEnabled(config, gatewayEnvironmentFromProcess())
    const desired = isBackgroundModeActive({
      gatewayEnabled,
      keepRunningInBackground: config.keepRunningInBackground,
    })
    this._applyLoginItem(config, gatewayEnabled)
    const wasDesired = this._desiredActive
    this._desiredActive = desired
    this._logger.info(`background mode desired=${desired} was=${wasDesired}`)
    if (desired) {
      if (this._tray === undefined && !this._trayFailed) this._activateTray()
      if (this.isActive()) this._startIdleScan()
      return
    }
    this._trayFailed = false
    this._stopIdleScan()
    if (wasDesired) this._deactivate()
  }

  /**
   * The login item is meaningful only while the gateway AND background mode are
   * on: otherwise a login launch would start an invisible process with no tray
   * to bring it back. Turning either switch off therefore unregisters it.
   */
  private _applyLoginItem(config: MobileGatewayConfig, gatewayEnabled: boolean): void {
    if (
      !supportsLoginItem({
        isPackaged: this._opts.isPackaged,
        platform: this._opts.platform,
        e2e: this._opts.e2eEnabled,
      })
    ) {
      return
    }
    const desired = config.launchAtLogin && config.keepRunningInBackground && gatewayEnabled
    if (!this._loginItemStateRead) {
      this._loginItemStateRead = true
      this._lastLoginItemOpenAtLogin = this._opts.getLoginItemOpenAtLogin?.()
    }
    if (this._lastLoginItemOpenAtLogin === desired) {
      this._logger.info(`background login item unchanged openAtLogin=${desired}`)
      return
    }
    this._lastLoginItemOpenAtLogin = desired
    const settings =
      this._opts.platform === 'win32'
        ? { openAtLogin: desired, args: ['--background'] }
        : { openAtLogin: desired }
    ;(this._opts.setLoginItem ?? defaultSetLoginItem)(settings)
    this._logger.info(`background login item updated openAtLogin=${desired}`)
  }

  private _activateTray(): void {
    const image = this._loadTrayImage()
    if (image.isEmpty()) {
      this._trayFailed = true
      this._logger.warn(
        `background mode disabled: tray icon is empty path=${this._opts.trayIconPath}`,
      )
      return
    }
    try {
      const tray = (this._opts.createTray ?? defaultCreateTray)(image)
      tray.setToolTip(localize('tray.tooltip', 'Universe Editor is running in the background'))
      tray.on('click', () => this._handleTrayClick())
      tray.on('right-click', () => this._popupTrayMenu())
      this._tray = tray
      this._logger.info('background mode tray created')
    } catch (err) {
      this._trayFailed = true
      this._logger.warn(`background mode disabled: tray creation failed: ${String(err)}`)
    }
  }

  /**
   * Reveal hidden windows BEFORE destroying the tray: once the tray is gone the
   * user must not be left with an invisible process and no way back to the UI.
   */
  private _deactivate(): void {
    this._logger.info('background mode deactivating')
    this._stopIdleScan()
    this._opts.windows.revealAllHiddenWindows()
    if (this._tray !== undefined) {
      this._tray.destroy()
      this._tray = undefined
    }
    this._trayFailed = false
    if (this._opts.windows.getWindowCount() === 0) void this.showPrimaryWindow()
  }

  private _startIdleScan(): void {
    if (this._idleTimer !== undefined) return
    const intervalMs = this._opts.idleScanIntervalMs ?? BACKGROUND_IDLE_SCAN_INTERVAL_MS
    this._idleTimer = setInterval(() => this._scanIdleWindows(), intervalMs)
    this._idleTimer.unref?.()
    this._logger.info(`background idle scan started intervalMs=${intervalMs}`)
  }

  private _stopIdleScan(): void {
    if (this._idleTimer !== undefined) {
      clearInterval(this._idleTimer)
      this._idleTimer = undefined
    }
    this._idleSince.clear()
  }

  private _scanIdleWindows(): void {
    if (!this.isActive()) return
    const candidates: IdleWindowCandidate[] = this._opts.windows
      .getHiddenWindowInfos()
      .map((info) => {
        const counts = this._opts.sessionCounts(info.id)
        return {
          windowId: info.id,
          hidden: true,
          running: counts.running,
          ask: counts.ask,
          hasSubscribers: this._opts.hasSessionSubscribers(info.id),
        }
      })
    const { idleSince, reclaim } = updateIdleState({
      idleSince: this._idleSince,
      candidates,
      now: Date.now(),
      thresholdMs: this._opts.idleReclaimAfterMs ?? BACKGROUND_IDLE_RECLAIM_MS,
    })
    this._idleSince = idleSince
    for (const windowId of reclaim) {
      this._logger.info(`background idle reclaim window=${windowId}`)
      this._opts.windows.closeWindowWithoutVeto(windowId)
    }
  }

  private _loadTrayImage(): NativeImage {
    try {
      if (this._opts.platform === 'win32') {
        return nativeImage.createFromPath(this._opts.trayIconPath)
      }
      const png = extractPngFromIco(readFileSync(this._opts.trayIconPath))
      if (png === undefined) return nativeImage.createEmpty()
      return nativeImage
        .createFromBuffer(png)
        .resize({ height: this._opts.platform === 'darwin' ? 16 : 22 })
    } catch (err) {
      this._logger.warn(`background mode tray icon failed: ${String(err)}`)
      return nativeImage.createEmpty()
    }
  }

  private _handleTrayClick(): void {
    // macOS convention: a click opens the menu, not the window.
    if (this._opts.platform === 'darwin') {
      this._popupTrayMenu()
      return
    }
    if (this._clickTimer !== undefined) return
    this._clickTimer = setTimeout(() => {
      this._clickTimer = undefined
      void this.showPrimaryWindow()
    }, TRAY_CLICK_DEBOUNCE_MS)
  }

  private _popupTrayMenu(): void {
    const tray = this._tray
    if (tray === undefined) return
    const template = buildTrayMenuTemplate({
      hiddenWindows: this._hiddenWindowInfos().map(({ id, name }) => ({ id, name })),
      gateway: {
        state: this._gatewayStatus?.state ?? 'stopped',
        ...(this._gatewayStatus?.listenAddress !== undefined
          ? { listenAddress: this._gatewayStatus.listenAddress }
          : {}),
      },
      actions: {
        showPrimary: () => {
          void this.showPrimaryWindow()
        },
        revealWindow: (id) => this._opts.windows.revealWindow(id),
        exit: () => this.exit(),
      },
    })
    const menu = Menu.buildFromTemplate(template as unknown as MenuItemConstructorOptions[])
    tray.popUpContextMenu(menu)
  }

  private _hiddenWindowInfos(): readonly { id: number; name: string; hiddenSeq: number }[] {
    return this._opts.windows.getHiddenWindowInfos()
  }

  private _resolveReadyOnce(): void {
    if (this._readyResolved) return
    this._readyResolved = true
    this._resolveReady()
  }
}
