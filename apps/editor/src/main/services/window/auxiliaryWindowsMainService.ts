/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Auxiliary editor windows are same-origin popups owned by a workspace window. They share
 *  the parent renderer (React portals / Monaco models) and therefore never get their own
 *  workspace service stack or IPC bridge.
 *
 *  Creation is capability-based: the parent renderer reserves a one-time token through its
 *  own IPC channel, then opens `about:blank` with that token as the window name. Only a
 *  matching, parent-bound token is allowed through the window-open policy; anything else
 *  is denied. The dedicated minimal preload keeps the full main preload (and its IPC
 *  bridge) out of the child.
 *--------------------------------------------------------------------------------------------*/

import {
  BrowserWindow,
  screen,
  type BrowserWindowConstructorOptions,
  type Display,
  type WindowOpenHandlerResponse,
} from 'electron'
import { randomBytes } from 'node:crypto'
import {
  DisposableStore,
  Emitter,
  Event,
  type Event as IEvent,
  type IDisposable,
  type ILogger,
} from '@universe-editor/platform'
import {
  type AuxiliaryWindowClosedEvent,
  type AuxiliaryWindowCloseRequest,
  type AuxiliaryWindowGeometry,
  type AuxiliaryWindowOpenOptions,
  type AuxiliaryWindowState,
  type IAuxiliaryWindowsService,
  type PreparedAuxiliaryWindow,
} from '../../../shared/ipc/auxiliaryWindowService.js'
import {
  applyWindowState,
  captureWindowState,
  trackWindowState,
  validateWindowState,
  type IWindowState,
} from '../../windowState.js'
import { ZOOM_STEP, clampZoomLevel } from '../../windowZoom.js'
import type { LogMainService } from '../log/logMainService.js'

/** The only URL an auxiliary window is ever allowed to open. */
export const AUXILIARY_WINDOW_OPEN_URL = 'about:blank'

const DEFAULT_WIDTH = 1000
const DEFAULT_HEIGHT = 700
const MIN_WIDTH = 200
const MIN_HEIGHT = 100
const CASCADE_OFFSET = 28
const DEFAULT_BACKGROUND = '#1e1e1e'
const PREPARED_TOKEN_TTL_MS = 60_000
const READY_TO_SHOW_TIMEOUT_MS = 4_000

interface BoundsLike {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

function sameBounds(a: BoundsLike, b: BoundsLike): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

function centerOf(bounds: BoundsLike): { x: number; y: number } {
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
}

function centerDistanceSq(a: BoundsLike, b: BoundsLike): number {
  const ca = centerOf(a)
  const cb = centerOf(b)
  return (ca.x - cb.x) ** 2 + (ca.y - cb.y) ** 2
}

export interface AuxiliaryWindowsMainServiceOptions {
  readonly preloadPath: string
  readonly silentE2E: boolean
  readonly logService: LogMainService
  readonly appName: string
  /** Override for deterministic window-option tests; defaults to `process.platform`. */
  readonly platform?: NodeJS.Platform
}

export interface CreatedAuxiliaryWindowDetails {
  readonly url: string
  readonly frameName: string
}

export interface AuxiliaryWindowStateEvent {
  readonly parentWindowId: number
  readonly window: AuxiliaryWindowState
}

export interface AuxiliaryWindowCloseRequestEvent {
  readonly parentWindowId: number
  readonly token: string
}

export interface AuxiliaryWindowClosedEventInternal {
  readonly parentWindowId: number
  readonly token: string
}

interface PreparedEntry {
  readonly token: string
  readonly parentWindowId: number
  readonly title: string
  readonly backgroundColor: string
  readonly state: IWindowState
  readonly createdAt: number
  approved: boolean
}

interface AuxiliaryWindowEntry {
  readonly token: string
  readonly parentWindowId: number
  readonly win: BrowserWindow
  readonly title: string
  readonly disposables: DisposableStore
  readonly initialState: IWindowState
  destroying: boolean
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export class AuxiliaryWindowsMainService implements IDisposable {
  private readonly _parents = new Map<number, BrowserWindow>()
  private readonly _prepared = new Map<string, PreparedEntry>()
  private readonly _windows = new Map<string, AuxiliaryWindowEntry>()
  private readonly _logger: ILogger

  private readonly _onDidCreateWindow = new Emitter<AuxiliaryWindowStateEvent>()
  readonly onDidCreateWindow: IEvent<AuxiliaryWindowStateEvent> = this._onDidCreateWindow.event
  private readonly _onDidCloseWindow = new Emitter<AuxiliaryWindowClosedEventInternal>()
  readonly onDidCloseWindow: IEvent<AuxiliaryWindowClosedEventInternal> =
    this._onDidCloseWindow.event
  private readonly _onDidRequestClose = new Emitter<AuxiliaryWindowCloseRequestEvent>()
  readonly onDidRequestClose: IEvent<AuxiliaryWindowCloseRequestEvent> =
    this._onDidRequestClose.event
  private readonly _onDidChangeWindowState = new Emitter<AuxiliaryWindowStateEvent>()
  readonly onDidChangeWindowState: IEvent<AuxiliaryWindowStateEvent> =
    this._onDidChangeWindowState.event

  constructor(private readonly _options: AuxiliaryWindowsMainServiceOptions) {
    this._logger = _options.logService.createLogger({
      id: 'auxiliary-window',
      name: 'Auxiliary Window',
    })
  }

  /** Track a workspace window as a legal auxiliary-window parent. */
  registerParent(win: BrowserWindow): void {
    this._parents.set(win.id, win)
  }

  /**
   * Consulted by the parent's `setWindowOpenHandler`. Returns `undefined` when this is
   * not an auxiliary-window request (the caller keeps its normal external-link policy).
   */
  handleWindowOpen(
    parent: BrowserWindow,
    url: string,
    frameName: string,
  ): WindowOpenHandlerResponse | undefined {
    if (url !== AUXILIARY_WINDOW_OPEN_URL) return undefined
    this._prunePrepared()
    if (this._parents.get(parent.id) !== parent) return { action: 'deny' }
    const prepared = this._prepared.get(frameName)
    if (!prepared || prepared.parentWindowId !== parent.id) {
      this._logger.warn(`denied unregistered about:blank window parent=${parent.id}`)
      return { action: 'deny' }
    }
    prepared.approved = true
    return {
      action: 'allow',
      overrideBrowserWindowOptions: this._browserWindowOptions(prepared),
    }
  }

  /**
   * Called from the parent's `did-create-window`. Registration only: no workspace
   * services, IPC bootstrap, session entry, or windowScopeFactory is created here.
   * The child is destroyed if it does not match a reserved token.
   */
  adoptCreatedWindow(
    parent: BrowserWindow,
    child: BrowserWindow,
    details: CreatedAuxiliaryWindowDetails,
  ): boolean {
    this._prunePrepared()
    const prepared = this._prepared.get(details.frameName)
    const valid =
      prepared !== undefined &&
      prepared.approved &&
      prepared.parentWindowId === parent.id &&
      details.url === AUXILIARY_WINDOW_OPEN_URL &&
      this._parents.get(parent.id) === parent
    if (!valid) {
      this._logger.warn(
        `destroyed unregistered auxiliary window parent=${parent.id} frameName=${details.frameName} url=${details.url}`,
      )
      this._destroySilently(child)
      return false
    }
    this._prepared.delete(prepared.token)
    const entry = this._registerWindow(prepared, child)
    this._logger.info(
      `created parent=${parent.id} id=${child.id} bounds=${prepared.state.x},${prepared.state.y},${prepared.state.width},${prepared.state.height}`,
    )
    this._onDidCreateWindow.fire({
      parentWindowId: entry.parentWindowId,
      window: this._captureState(entry),
    })
    return true
  }

  prepareOpen(
    parentWindowId: number,
    options?: AuxiliaryWindowOpenOptions,
  ): PreparedAuxiliaryWindow {
    const parent = this._parents.get(parentWindowId)
    if (!parent || parent.isDestroyed()) {
      throw new Error(`Cannot prepare an auxiliary window for a closed parent ${parentWindowId}`)
    }
    this._prunePrepared()
    const token = randomBytes(24).toString('hex')
    const cascadeIndex =
      [...this._windows.values()].filter((entry) => entry.parentWindowId === parentWindowId)
        .length +
      [...this._prepared.values()].filter((entry) => entry.parentWindowId === parentWindowId).length
    const state = this._resolveGeometry(parent, options, cascadeIndex)
    this._prepared.set(token, {
      token,
      parentWindowId,
      title: options?.title ?? this._options.appName,
      backgroundColor: options?.backgroundColor ?? DEFAULT_BACKGROUND,
      state,
      createdAt: Date.now(),
      approved: false,
    })
    this._logger.info(
      `prepared parent=${parentWindowId} bounds=${state.x},${state.y},${state.width},${state.height}`,
    )
    return { token, frameName: token }
  }

  cancelPrepared(parentWindowId: number, token: string): void {
    const prepared = this._prepared.get(token)
    if (!prepared || prepared.parentWindowId !== parentWindowId) return
    this._prepared.delete(token)
    this._logger.info(`cancelled prepared parent=${parentWindowId}`)
  }

  getWindows(parentWindowId: number): AuxiliaryWindowState[] {
    return [...this._windows.values()]
      .filter((entry) => entry.parentWindowId === parentWindowId && !entry.win.isDestroyed())
      .map((entry) => this._captureState(entry))
  }

  getWindowState(parentWindowId: number, token: string): AuxiliaryWindowState | null {
    const entry = this._entryFor(parentWindowId, token)
    return entry && !entry.win.isDestroyed() ? this._captureState(entry) : null
  }

  /**
   * Native window for a token owned by `parentWindowId`. Used to target OS
   * notifications (focus gate, taskbar attention, click focus) at the
   * auxiliary window whose session raised them.
   */
  getWindowForToken(parentWindowId: number, token: string): BrowserWindow | undefined {
    const entry = this._entryFor(parentWindowId, token)
    return entry !== undefined && !entry.win.isDestroyed() ? entry.win : undefined
  }

  focusWindow(parentWindowId: number, token: string): void {
    const entry = this._requireEntry(parentWindowId, token)
    if (entry.win.isDestroyed()) return
    // A minimized window ignores focus() on Windows; restore first so commands
    // that reveal an editor there actually bring it back.
    if (entry.win.isMinimized()) entry.win.restore()
    if (this._options.silentE2E) entry.win.showInactive()
    else entry.win.focus()
  }

  minimizeWindow(parentWindowId: number, token: string): void {
    const entry = this._requireEntry(parentWindowId, token)
    if (entry.win.isDestroyed()) return
    entry.win.minimize()
  }

  toggleMaximizeWindow(parentWindowId: number, token: string): void {
    const entry = this._requireEntry(parentWindowId, token)
    if (entry.win.isDestroyed()) return
    if (entry.win.isMaximized()) entry.win.unmaximize()
    else entry.win.maximize()
  }

  requestClose(parentWindowId: number, token: string): void {
    const entry = this._requireEntry(parentWindowId, token)
    if (entry.win.isDestroyed()) return
    entry.win.close()
  }

  finalizeClose(parentWindowId: number, token: string): void {
    const entry = this._entryFor(parentWindowId, token)
    if (!entry) return
    this._destroyEntry(entry, 'finalize-close')
  }

  zoomIn(parentWindowId: number, token: string): void {
    this._applyZoom(parentWindowId, token, (level) => level + ZOOM_STEP)
  }

  zoomOut(parentWindowId: number, token: string): void {
    this._applyZoom(parentWindowId, token, (level) => level - ZOOM_STEP)
  }

  resetZoom(parentWindowId: number, token: string): void {
    this._applyZoom(parentWindowId, token, () => 0)
  }

  /**
   * The BrowserWindow a native dialog should be modal to. When one of this parent's
   * auxiliary windows is focused, follow it; otherwise keep the workspace window.
   */
  getDialogParent(parentWindowId: number, fallback: BrowserWindow): BrowserWindow {
    const focused = BrowserWindow.getFocusedWindow()
    if (!focused || focused.isDestroyed()) return fallback
    if (focused.id === parentWindowId) return focused
    for (const entry of this._windows.values()) {
      if (entry.parentWindowId === parentWindowId && entry.win.id === focused.id) return focused
    }
    return fallback
  }

  /**
   * Workspace window that owns the auxiliary window `windowId`. Window-scoped
   * commands (getFocusedWindowId) map an auxiliary focus back to its parent,
   * because auxiliary windows share the parent renderer and have no services of
   * their own.
   */
  getParentWindowId(windowId: number): number | undefined {
    for (const entry of this._windows.values()) {
      if (entry.win.id !== windowId || entry.win.isDestroyed()) continue
      return entry.parentWindowId
    }
    return undefined
  }

  /**
   * Tear down every auxiliary window owned by a parent. Called only at points where the
   * parent is really going away (accepted close, reload, renderer crash, quit), never
   * while its renderer is still deciding whether a close veto should hold.
   */
  disposeParent(parentWindowId: number, reason: string): void {
    // A reload or renderer crash replaces the renderer but keeps the BrowserWindow,
    // so the parent must stay registered for the rebuilt renderer to create new
    // auxiliary windows. Only drop it once the window itself is gone.
    const parent = this._parents.get(parentWindowId)
    if (!parent || parent.isDestroyed()) this._parents.delete(parentWindowId)
    for (const [token, prepared] of this._prepared) {
      if (prepared.parentWindowId === parentWindowId) this._prepared.delete(token)
    }
    const entries = [...this._windows.values()].filter(
      (entry) => entry.parentWindowId === parentWindowId,
    )
    if (entries.length > 0) {
      this._logger.info(
        `disposing parent=${parentWindowId} reason=${reason} windows=${entries.length}`,
      )
    }
    for (const entry of entries) this._destroyEntry(entry, reason)
  }

  disposeAll(reason: string): void {
    for (const parentWindowId of [...this._parents.keys()]) {
      this.disposeParent(parentWindowId, reason)
    }
  }

  dispose(): void {
    this.disposeAll('service-dispose')
    this._parents.clear()
    this._onDidCreateWindow.dispose()
    this._onDidCloseWindow.dispose()
    this._onDidRequestClose.dispose()
    this._onDidChangeWindowState.dispose()
  }

  private _browserWindowOptions(prepared: PreparedEntry): BrowserWindowConstructorOptions {
    const platform = this._options.platform ?? process.platform
    return {
      x: prepared.state.x,
      y: prepared.state.y,
      width: prepared.state.width,
      height: prepared.state.height,
      show: false,
      // Match the main window's chrome: the renderer draws the title bar so it
      // follows the theme (a native frame is OS-colored and cannot).
      ...(platform === 'darwin'
        ? { titleBarStyle: 'hidden' as const, trafficLightPosition: { x: 8, y: 8 } }
        : { frame: false }),
      autoHideMenuBar: true,
      title: prepared.title,
      backgroundColor: prepared.backgroundColor,
      webPreferences: {
        preload: this._options.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // The child document is same-origin about:blank. Keep web security on even
        // when the dev parent disables it for cross-origin preview images.
        webSecurity: true,
        webviewTag: false,
        nodeIntegrationInSubFrames: false,
        ...(process.env['UNIVERSE_E2E_THROTTLE'] ? {} : { backgroundThrottling: false }),
      },
    }
  }

  private _registerWindow(prepared: PreparedEntry, win: BrowserWindow): AuxiliaryWindowEntry {
    const disposables = new DisposableStore()
    const entry: AuxiliaryWindowEntry = {
      token: prepared.token,
      parentWindowId: prepared.parentWindowId,
      win,
      title: prepared.title,
      disposables,
      initialState: prepared.state,
      destroying: false,
    }
    this._windows.set(entry.token, entry)

    const webContents = win.webContents
    // No nested windows, no navigation, no Electron <webview>. Same-document iframes
    // remain available for the controlled preview/custom-editor channel.
    webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    webContents.on('will-navigate', (event) => event.preventDefault())
    webContents.on('will-redirect', (event) => event.preventDefault())
    webContents.on('will-attach-webview', (event) => event.preventDefault())

    win.setMenu(null)
    win.on('close', (event) => {
      if (entry.destroying || win.isDestroyed()) return
      // The renderer owns the transaction: move protected editors out, then finalize.
      event.preventDefault()
      this._onDidRequestClose.fire({
        parentWindowId: entry.parentWindowId,
        token: entry.token,
      })
    })
    win.on('closed', () => this._cleanupEntry(entry))

    const emitState = (): void => {
      if (entry.destroying || win.isDestroyed() || !this._windows.has(entry.token)) return
      this._onDidChangeWindowState.fire({
        parentWindowId: entry.parentWindowId,
        window: this._captureState(entry),
      })
    }
    win.on('focus', emitState)
    win.on('blur', emitState)
    win.on('show', emitState)
    win.on('hide', emitState)
    // trackWindowState debounces resize; maximize toggles must repaint the
    // renderer-drawn title bar's restore icon immediately.
    win.on('maximize', emitState)
    win.on('unmaximize', emitState)
    win.on('enter-full-screen', emitState)
    win.on('leave-full-screen', emitState)
    disposables.add(trackWindowState(win, emitState))

    this._wireShow(entry)
    return entry
  }

  private _wireShow(entry: AuxiliaryWindowEntry): void {
    const { win } = entry
    let shown = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const show = (): void => {
      if (shown || win.isDestroyed() || entry.destroying) return
      shown = true
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
      applyWindowState(win, entry.initialState)
      if (this._options.silentE2E) win.showInactive()
      else win.show()
      this._onDidChangeWindowState.fire({
        parentWindowId: entry.parentWindowId,
        window: this._captureState(entry),
      })
    }
    win.once('ready-to-show', show)
    win.webContents.once('did-finish-load', show)
    timer = setTimeout(show, READY_TO_SHOW_TIMEOUT_MS)
    entry.disposables.add({
      dispose: () => {
        if (timer !== undefined) clearTimeout(timer)
        timer = undefined
      },
    })
  }

  private _resolveGeometry(
    parent: BrowserWindow,
    options: AuxiliaryWindowOpenOptions | undefined,
    cascadeIndex: number,
  ): IWindowState {
    const input = options?.geometry
    // Explicit geometry (drag-out, workspace restore) is authoritative; the
    // display hint must never move a window the user placed deliberately.
    if (options?.preferOtherDisplayFullscreen === true && input === undefined) {
      const other = this._resolveOtherDisplayFullscreen(this._placementSourceWindow(parent))
      if (other) return other
    }
    // Reuse the persisted-window validator: rejects malformed/off-screen restore data.
    // Raw values still go through the clamp below so the result is always reachable.
    const restored = input ? validateWindowState(input) : undefined
    const parentBounds = parent.getNormalBounds()
    const anchor = {
      x: input?.x ?? parentBounds.x + parentBounds.width / 2,
      y: input?.y ?? parentBounds.y + parentBounds.height / 2,
    }
    const display = screen.getDisplayNearestPoint({
      x: Math.round(anchor.x),
      y: Math.round(anchor.y),
    })
    const workArea = display.workArea
    const defaultWidth = Math.min(DEFAULT_WIDTH, Math.round(parentBounds.width * 0.8))
    const defaultHeight = Math.min(DEFAULT_HEIGHT, Math.round(parentBounds.height * 0.8))
    const width = clampNumber(
      Math.round(restored?.width ?? input?.width ?? defaultWidth),
      MIN_WIDTH,
      workArea.width,
    )
    const height = clampNumber(
      Math.round(restored?.height ?? input?.height ?? defaultHeight),
      MIN_HEIGHT,
      workArea.height,
    )
    const cascade = CASCADE_OFFSET * (cascadeIndex + 1)
    const desiredX = restored?.x ?? input?.x ?? parentBounds.x + cascade
    const desiredY = restored?.y ?? input?.y ?? parentBounds.y + cascade
    return {
      x: clampNumber(Math.round(desiredX), workArea.x, workArea.x + workArea.width - width),
      y: clampNumber(Math.round(desiredY), workArea.y, workArea.y + workArea.height - height),
      width,
      height,
      isMaximized: restored?.isMaximized ?? input?.isMaximized === true,
      isFullscreen: restored?.isFullscreen ?? input?.isFullscreen === true,
      displayId: display.id,
      displayBounds: { ...display.bounds },
    }
  }

  /**
   * The window whose display counts as "current" for placement hints. Prefer the
   * focused window when it belongs to this parent (the user may be working in an
   * auxiliary window on another monitor); otherwise fall back to the workspace
   * window.
   */
  private _placementSourceWindow(parent: BrowserWindow): BrowserWindow {
    const focused = BrowserWindow.getFocusedWindow()
    if (!focused || focused.isDestroyed()) return parent
    if (focused.id === parent.id) return focused
    return this.getParentWindowId(focused.id) === parent.id ? focused : parent
  }

  /**
   * Fullscreen geometry on a different display, or undefined when the setup has no
   * usable second display (single monitor, or mirrored displays sharing bounds).
   * Mirrored displays are filtered by bounds so "another display" does not land on
   * the same physical area.
   */
  private _resolveOtherDisplayFullscreen(source: BrowserWindow): IWindowState | undefined {
    // Fullscreen/maximized windows report their restored position from
    // getNormalBounds, which can still name the display they were on before —
    // the user sees the current bounds instead.
    const sourceBounds =
      source.isMaximized() || source.isFullScreen() ? source.getBounds() : source.getNormalBounds()
    const sourceDisplay = screen.getDisplayNearestPoint({
      x: Math.round(sourceBounds.x + sourceBounds.width / 2),
      y: Math.round(sourceBounds.y + sourceBounds.height / 2),
    })
    const candidates: Display[] = screen
      .getAllDisplays()
      .filter(
        (display) =>
          display.id !== sourceDisplay.id && !sameBounds(display.bounds, sourceDisplay.bounds),
      )
    if (candidates.length === 0) return undefined
    const target = [...candidates].sort(
      (a, b) =>
        centerDistanceSq(a.bounds, sourceDisplay.bounds) -
          centerDistanceSq(b.bounds, sourceDisplay.bounds) || a.id - b.id,
    )[0]!
    return {
      x: target.bounds.x,
      y: target.bounds.y,
      width: target.bounds.width,
      height: target.bounds.height,
      isMaximized: false,
      isFullscreen: true,
      displayId: target.id,
      displayBounds: { ...target.bounds },
    }
  }

  private _captureState(entry: AuxiliaryWindowEntry): AuxiliaryWindowState {
    const captured = captureWindowState(entry.win)
    const geometry: AuxiliaryWindowGeometry = {
      x: captured.x,
      y: captured.y,
      width: captured.width,
      height: captured.height,
      isMaximized: captured.isMaximized,
      isFullscreen: captured.isFullscreen,
      displayId: captured.displayId,
      ...(captured.displayBounds ? { displayBounds: { ...captured.displayBounds } } : {}),
    }
    return {
      token: entry.token,
      title: entry.title,
      geometry,
      isFocused: entry.win.isFocused(),
      isVisible: entry.win.isVisible(),
    }
  }

  private _entryFor(parentWindowId: number, token: string): AuxiliaryWindowEntry | undefined {
    const entry = this._windows.get(token)
    return entry?.parentWindowId === parentWindowId ? entry : undefined
  }

  private _requireEntry(parentWindowId: number, token: string): AuxiliaryWindowEntry {
    const entry = this._entryFor(parentWindowId, token)
    if (!entry) throw new Error(`Unknown auxiliary window token ${token}`)
    return entry
  }

  private _destroyEntry(entry: AuxiliaryWindowEntry, reason: string): void {
    entry.destroying = true
    this._logger.info(`destroy parent=${entry.parentWindowId} reason=${reason}`)
    if (!entry.win.isDestroyed()) entry.win.destroy()
    this._cleanupEntry(entry)
  }

  private _destroySilently(win: BrowserWindow): void {
    if (!win.isDestroyed()) win.destroy()
  }

  private _cleanupEntry(entry: AuxiliaryWindowEntry): void {
    if (!this._windows.has(entry.token)) return
    this._windows.delete(entry.token)
    entry.disposables.dispose()
    this._logger.info(`closed parent=${entry.parentWindowId}`)
    this._onDidCloseWindow.fire({
      parentWindowId: entry.parentWindowId,
      token: entry.token,
    })
  }

  private _applyZoom(parentWindowId: number, token: string, next: (level: number) => number): void {
    const entry = this._requireEntry(parentWindowId, token)
    if (entry.win.isDestroyed()) return
    const webContents = entry.win.webContents
    const level = clampZoomLevel(next(webContents.getZoomLevel()))
    webContents.setZoomLevel(level)
  }

  private _prunePrepared(): void {
    const deadline = Date.now() - PREPARED_TOKEN_TTL_MS
    for (const [token, prepared] of this._prepared) {
      if (prepared.createdAt < deadline) this._prepared.delete(token)
    }
  }
}

/**
 * Per-parent wire adapter. Registering this instance on the parent's ChannelServer makes
 * ownership structural: the renderer cannot name another BrowserWindow, and a token
 * reserved by a different parent is rejected by the underlying service.
 */
export class WindowScopedAuxiliaryWindowsService implements IAuxiliaryWindowsService {
  declare readonly _serviceBrand: undefined

  readonly onDidCreateWindow: IEvent<AuxiliaryWindowState>
  readonly onDidCloseWindow: IEvent<AuxiliaryWindowClosedEvent>
  readonly onDidRequestClose: IEvent<AuxiliaryWindowCloseRequest>
  readonly onDidChangeWindowState: IEvent<AuxiliaryWindowState>

  constructor(
    private readonly _service: AuxiliaryWindowsMainService,
    private readonly _parentWindowId: number,
  ) {
    const own = <T extends { parentWindowId: number }>(event: IEvent<T>): IEvent<T> =>
      Event.filter(event, (payload) => payload.parentWindowId === this._parentWindowId)
    this.onDidCreateWindow = Event.map(own(_service.onDidCreateWindow), (payload) => payload.window)
    this.onDidCloseWindow = Event.map(
      Event.filter(
        _service.onDidCloseWindow,
        (payload) => payload.parentWindowId === this._parentWindowId,
      ),
      (payload) => ({ token: payload.token }),
    )
    this.onDidRequestClose = Event.map(
      Event.filter(
        _service.onDidRequestClose,
        (payload) => payload.parentWindowId === this._parentWindowId,
      ),
      (payload) => ({ token: payload.token }),
    )
    this.onDidChangeWindowState = Event.map(
      own(_service.onDidChangeWindowState),
      (payload) => payload.window,
    )
  }

  async prepareOpen(options?: AuxiliaryWindowOpenOptions): Promise<PreparedAuxiliaryWindow> {
    return this._service.prepareOpen(this._parentWindowId, options)
  }

  async cancelPrepared(token: string): Promise<void> {
    this._service.cancelPrepared(this._parentWindowId, token)
  }

  getWindows(): Promise<readonly AuxiliaryWindowState[]> {
    return Promise.resolve(this._service.getWindows(this._parentWindowId))
  }

  getWindowState(token: string): Promise<AuxiliaryWindowState | null> {
    return Promise.resolve(this._service.getWindowState(this._parentWindowId, token))
  }

  async focusWindow(token: string): Promise<void> {
    this._service.focusWindow(this._parentWindowId, token)
  }

  async minimizeWindow(token: string): Promise<void> {
    this._service.minimizeWindow(this._parentWindowId, token)
  }

  async toggleMaximizeWindow(token: string): Promise<void> {
    this._service.toggleMaximizeWindow(this._parentWindowId, token)
  }

  async requestClose(token: string): Promise<void> {
    this._service.requestClose(this._parentWindowId, token)
  }

  async finalizeClose(token: string): Promise<void> {
    this._service.finalizeClose(this._parentWindowId, token)
  }

  async zoomIn(token: string): Promise<void> {
    this._service.zoomIn(this._parentWindowId, token)
  }

  async zoomOut(token: string): Promise<void> {
    this._service.zoomOut(this._parentWindowId, token)
  }

  async resetZoom(token: string): Promise<void> {
    this._service.resetZoom(this._parentWindowId, token)
  }
}
