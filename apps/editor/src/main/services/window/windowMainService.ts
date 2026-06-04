/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  WindowMainService: owns the full lifecycle of BrowserWindows — creation,
 *  IPC bootstrap, state tracking, and disposal. Also owns the multi-window
 *  session list: which windows (workspace + geometry + devtools) were open, so
 *  the app can restore them on next launch.
 *--------------------------------------------------------------------------------------------*/

import { BrowserWindow, dialog } from 'electron'
import { basename } from 'node:path'
import { homedir } from 'node:os'
import {
  DisposableStore,
  Emitter,
  localize,
  mark,
  ShutdownReason,
  URI,
  type Event,
  type IOpenWindowInfo,
  type IWorkspace,
} from '@universe-editor/platform'
import { E2E_PROBE_ARGV_FLAG } from '../../../shared/e2e/contract.js'
import { PerfMarks } from '../../../shared/perf/marks.js'
import { bootstrapWindowIpc } from '../../ipc/registerMainServices.js'
import { type IRendererLifecycleService } from '../../../shared/ipc/lifecycleService.js'
import { MainHostService } from '../host/hostMainService.js'
import { MainWindowsService } from './windowsMainService.js'
import { MainLogChannelService } from '../log/mainLogChannelService.js'
import { type LogMainService } from '../log/logMainService.js'
import { MainStorageService } from '../storage/storageMainService.js'
import { WorkspaceMainService } from '../workspace/workspaceMainService.js'
import { UserDataMainService } from '../userData/userDataMainService.js'
import { TerminalMainService } from '../terminal/terminalMainService.js'
import { ElectronFolderDialog } from '../workspace/electronFolderDialog.js'
import {
  applyWindowState,
  captureWindowState,
  trackWindowState,
  type IWindowState,
} from '../../windowState.js'
import { observeDevToolsState } from '../../devToolsState.js'
import { getDefaultStorage, workspaceIdFromUri } from '../../storage.js'
import {
  serializeWindow,
  WINDOWS_SESSION_STORAGE_KEY,
  type IPersistedWindow,
  type IRestoreWindow,
} from '../../windowsSession.js'
import type {
  ApplicationServices,
  WindowScopedServices,
} from '../../window/scopedServicesFactory.js'

export interface ICreateWindowOptions {
  /** Workspace to restore into this window (session restore). Undefined/null → empty window. */
  readonly workspace?: IWorkspace | null
  /** Window geometry to restore. */
  readonly uiState?: IWindowState
  /** Whether DevTools should be opened. */
  readonly devToolsOpen?: boolean
}

export interface IWindowMainService {
  readonly onDidChangeWindows: Event<void>
  createWindow(opts?: ICreateWindowOptions): Promise<number>
  restoreSession(list: readonly IRestoreWindow[]): Promise<void>
  focusWindow(id: number): void
  getWindowById(id: number): BrowserWindow | undefined
  getWindows(): ReadonlyArray<BrowserWindow>
  getOpenWindowInfos(): IOpenWindowInfo[]
  openWindowForFolder(folder?: URI): Promise<void>
  captureSessionForQuit(): void
  confirmQuit(): Promise<boolean>
  isQuitConfirmed(): boolean
  dispose(): void
}

interface WindowEntry {
  readonly win: BrowserWindow
  readonly workspace: WorkspaceMainService
  readonly disposables: DisposableStore
  readonly rendererLifecycle: IRendererLifecycleService
}

export interface WindowMainServiceOptions {
  readonly appServices: ApplicationServices
  readonly logService: LogMainService
  readonly e2eEnabled: boolean
  /** Delay renderer load so VS Code's Chrome debugger can attach (dev only). */
  readonly rendererDebug: boolean
  /** Absolute path to app icon (.ico on Windows). */
  readonly appIconPath?: string
  /** Absolute path to the preload script. */
  readonly preloadPath: string
  /** electron-vite dev server URL (undefined in production). */
  readonly rendererUrl: string | undefined
  /** Absolute path to renderer/index.html (production). */
  readonly rendererHtml: string
}

const SESSION_PERSIST_DEBOUNCE_MS = 300

export class WindowMainService implements IWindowMainService {
  private readonly _windows = new Map<number, WindowEntry>()
  private _quitting = false
  /** Set once a quit has been confirmed (renderer cleared, or a restart path
   *  already confirmed) so before-quit doesn't prompt a second time. */
  private _quitConfirmed = false
  /** Window ids cleared to close — set after a confirmed close/quit so the
   *  close handler bypasses the renderer veto round-trip on the second pass. */
  private readonly _allowClose = new Set<number>()
  private _sessionPersistTimer: ReturnType<typeof setTimeout> | null = null
  private _hasCreatedFirstWindow = false

  private readonly _onDidChangeWindows = new Emitter<void>()
  readonly onDidChangeWindows: Event<void> = this._onDidChangeWindows.event

  constructor(private readonly _opts: WindowMainServiceOptions) {}

  async createWindow(opts?: ICreateWindowOptions): Promise<number> {
    const {
      e2eEnabled,
      rendererDebug,
      appIconPath,
      preloadPath,
      rendererUrl,
      rendererHtml,
      appServices,
      logService,
    } = this._opts
    const logger = logService.createLogger({ id: 'window', name: 'Window' })
    const isFirstWindow = !this._hasCreatedFirstWindow
    this._hasCreatedFirstWindow = true

    const isMac = process.platform === 'darwin'
    const uiState = opts?.uiState
    logger.info(
      `createWindow start e2e=${e2eEnabled} dev=${rendererUrl !== undefined} restoredState=${uiState !== undefined} workspace=${opts?.workspace?.folder.toString() ?? '<none>'}`,
    )
    mark(PerfMarks.mainWillCreateWindow)

    const win = new BrowserWindow({
      width: uiState?.width ?? 1280,
      height: uiState?.height ?? 800,
      ...(uiState ? { x: uiState.x, y: uiState.y } : {}),
      show: false,
      backgroundColor: '#1e1e1e',
      title: localize('app.name', 'Universe Editor'),
      ...(appIconPath ? { icon: appIconPath } : {}),
      ...(isMac
        ? { titleBarStyle: 'hidden' as const, trafficLightPosition: { x: 8, y: 8 } }
        : { frame: false }),
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        additionalArguments: [
          `--ue-home-dir=${homedir()}`,
          ...(e2eEnabled ? [E2E_PROBE_ARGV_FLAG] : []),
        ],
      },
    })

    win.once('ready-to-show', () => {
      if (uiState) applyWindowState(win, uiState)
      win.show()
      if (opts?.devToolsOpen) win.webContents.openDevTools()
      mark(PerfMarks.mainDidShowWindow)
      logger.info(`readyToShow id=${win.id}`)
    })

    // Per-window services — each window gets its own workspace stack so opening
    // a folder in one window does not affect the others. GLOBAL state (state.json,
    // recent list) stays shared via the app-singleton backends.
    const disposables = new DisposableStore()
    const windowStorage = disposables.add(new MainStorageService(getDefaultStorage()))
    const folderDialog = new ElectronFolderDialog(win)
    const workspace = disposables.add(
      new WorkspaceMainService(
        windowStorage,
        appServices.recentWorkspaces,
        folderDialog,
        logService.createLogger({ id: 'workspace', name: 'Workspace' }),
        (workspaceId) => this._focusWindowForWorkspace(workspaceId),
      ),
    )
    // Restore the workspace before loadURL so the renderer's getCurrent() at
    // startup already sees it (and the WORKSPACE scope is bound for editor restore).
    if (opts?.workspace) {
      await workspace.restoreCurrent(opts.workspace)
    }
    const userData = disposables.add(new UserDataMainService(workspace))
    const host = disposables.add(
      new MainHostService(
        win,
        () => {
          void this.createWindow({})
        },
        logService.createLogger({ id: 'host', name: 'Host' }),
        rendererUrl !== undefined || e2eEnabled,
        {
          getRendererLifecycle: () => this._windows.get(win.id)?.rendererLifecycle,
          onConfirmedQuit: () => this.markQuitConfirmed(),
        },
      ),
    )
    const logChannel = new MainLogChannelService(logService)
    const terminal = disposables.add(new TerminalMainService(undefined, logService))
    const windowServices: WindowScopedServices = {
      host,
      logChannel,
      storage: windowStorage,
      workspace,
      userData,
      terminal,
    }

    const windowsService = disposables.add(new MainWindowsService(this, isFirstWindow))
    const ipc = bootstrapWindowIpc(win, appServices, windowServices, windowsService)
    disposables.add(ipc.disposable)

    // Persist the session whenever this window's workspace or geometry changes.
    disposables.add(
      workspace.onDidChangeWorkspace(() => {
        this._scheduleSessionPersist()
        this._onDidChangeWindows.fire()
      }),
    )
    disposables.add(trackWindowState(win, () => this._scheduleSessionPersist()))
    disposables.add(observeDevToolsState(win, () => this._scheduleSessionPersist()))

    const entry: WindowEntry = {
      win,
      workspace,
      disposables,
      rendererLifecycle: ipc.rendererLifecycle,
    }
    this._windows.set(win.id, entry)
    logger.info(`createWindow created id=${win.id}`)
    this._scheduleSessionPersist()
    this._onDidChangeWindows.fire()

    // Closing a window: unless already cleared (single close confirmed, or quit
    // confirmed upstream in before-quit), ask the renderer first so running
    // sessions can be guarded. The renderer being unreachable must never wedge
    // the close — default to proceeding.
    win.on('close', (e) => {
      if (this._allowClose.has(win.id)) {
        // Cleared: flush pending workspace writes before teardown, otherwise
        // debounced persistence (e.g. editor-group state) can be lost on close.
        void windowStorage.flush().finally(() => disposables.dispose())
        return
      }
      e.preventDefault()
      void this._confirmAndClose(entry)
    })
    win.on('closed', () => {
      this._windows.delete(win.id)
      this._allowClose.delete(win.id)
      logger.info(`closed id=${win.id}`)
      this._onDidChangeWindows.fire()
      // Persist the remaining windows when the user closes one of several. When
      // the LAST window is closed (size 0) we skip, so the session still holds
      // that window for restore. Skip entirely while quitting — captureSessionForQuit
      // already snapshotted the full set.
      if (!this._quitting && this._windows.size > 0) void this._persistSessionNow()
    })

    if (rendererUrl) {
      if (rendererDebug) {
        // Give VS Code's Chrome debugger time to attach to the BrowserWindow at about:blank
        // before the renderer URL loads. Without this delay, main.tsx executes before the
        // debugger can register breakpoints, making startup breakpoints unreachable.
        logger.info(`VSCODE_RENDERER_DEBUG: waiting 3s for Chrome debugger to attach`)
        await new Promise<void>((resolve) => setTimeout(resolve, 3000))
      }
      logger.info(`loadURL id=${win.id} url=${rendererUrl}`)
      void win.loadURL(rendererUrl).catch((err) => {
        logger.error(`loadURL failed id=${win.id}`, err)
      })
    } else {
      logger.info(`loadFile id=${win.id} file=${rendererHtml}`)
      void win.loadFile(rendererHtml).catch((err) => {
        logger.error(`loadFile failed id=${win.id}`, err)
      })
    }

    return win.id
  }

  /**
   * Restore a previously persisted session. Opens one window per entry (skipping
   * duplicate workspaces defensively). An empty list opens a single empty window.
   */
  async restoreSession(list: readonly IRestoreWindow[]): Promise<void> {
    if (list.length === 0) {
      await this.createWindow({})
      return
    }
    const seen = new Set<string>()
    for (const entry of list) {
      const id = entry.workspace ? workspaceIdFromUri(entry.workspace.folder.toString()) : null
      if (id !== null) {
        if (seen.has(id)) continue
        seen.add(id)
      }
      await this.createWindow({
        workspace: entry.workspace,
        ...(entry.uiState ? { uiState: entry.uiState } : {}),
        devToolsOpen: entry.devToolsOpen,
      })
    }
  }

  focusWindow(id: number): void {
    const entry = this._windows.get(id)
    if (entry && !entry.win.isDestroyed()) {
      entry.win.focus()
      this._opts.logService.createLogger({ id: 'window', name: 'Window' }).debug(`focus id=${id}`)
    }
  }

  getWindowById(id: number): BrowserWindow | undefined {
    return this._windows.get(id)?.win
  }

  getWindows(): ReadonlyArray<BrowserWindow> {
    return Array.from(this._windows.values()).map((e) => e.win)
  }

  getOpenWindowInfos(): IOpenWindowInfo[] {
    const infos: IOpenWindowInfo[] = []
    for (const { win, workspace } of this._windows.values()) {
      if (win.isDestroyed()) continue
      const current = workspace.current
      infos.push({
        id: win.id,
        folder: current ? current.folder.toJSON() : null,
        name: current ? current.name : null,
      })
    }
    return infos
  }

  /**
   * Open a window for `folder`. When omitted, prompt with a native folder picker
   * first. If the folder is already open in some window, focus it instead of
   * creating a duplicate (single-writer-per-workspace constraint).
   */
  async openWindowForFolder(folder?: URI): Promise<void> {
    let resolved = folder ?? null
    if (!resolved) {
      const parent = BrowserWindow.getFocusedWindow()
      const result = parent
        ? await dialog.showOpenDialog(parent, { properties: ['openDirectory'] })
        : await dialog.showOpenDialog({ properties: ['openDirectory'] })
      const picked = result.canceled ? undefined : result.filePaths[0]
      if (!picked) return
      resolved = URI.file(picked)
    }
    const workspace: IWorkspace = {
      folder: resolved,
      name: basename(resolved.fsPath) || resolved.fsPath,
    }
    const workspaceId = workspaceIdFromUri(workspace.folder.toString())
    if (this._focusWindowForWorkspace(workspaceId)) return
    await this._opts.appServices.recentWorkspaces.add(workspace)
    await this.createWindow({ workspace })
  }

  /**
   * Snapshot the full session right before the app quits, before windows start
   * closing (which would otherwise shrink the persisted list). The fire-and-forget
   * write is drained by getDefaultStorage().flush() in will-quit.
   */
  captureSessionForQuit(): void {
    this._quitting = true
    if (this._windows.size > 0) void this._persistSessionNow()
  }

  /**
   * Ask the renderer whether the app may quit. Polls every window's lifecycle
   * veto chain; a single veto aborts the quit. On success, marks every window
   * as cleared so their close handlers bypass the per-window confirm.
   */
  async confirmQuit(): Promise<boolean> {
    for (const { win, rendererLifecycle } of this._windows.values()) {
      if (win.isDestroyed()) continue
      if (!(await this._canProceed(rendererLifecycle, ShutdownReason.Quit))) return false
    }
    this.markQuitConfirmed()
    return true
  }

  isQuitConfirmed(): boolean {
    return this._quitConfirmed
  }

  /** Commit to quitting: skip further before-quit prompts and let every window's
   *  close handler bypass the per-window confirm. */
  markQuitConfirmed(): void {
    this._quitConfirmed = true
    for (const id of this._windows.keys()) this._allowClose.add(id)
  }

  /** Run the renderer veto round-trip for a single window close, then close. */
  private async _confirmAndClose(entry: WindowEntry): Promise<void> {
    const proceed = await this._canProceed(entry.rendererLifecycle, ShutdownReason.CloseWindow)
    if (!proceed) return
    this._allowClose.add(entry.win.id)
    if (!entry.win.isDestroyed()) entry.win.close()
  }

  /** Ask the renderer; treat an unreachable renderer / error as "proceed". */
  private async _canProceed(
    rendererLifecycle: IRendererLifecycleService,
    reason: ShutdownReason,
  ): Promise<boolean> {
    try {
      return await rendererLifecycle.confirmShutdown(reason)
    } catch {
      return true
    }
  }

  /**
   * If a window already has the given workspace open, focus it and return true;
   * otherwise return false. Used to avoid opening the same folder in two windows
   * (which would also race on the same workspaces/<id>.json backend).
   */
  private _focusWindowForWorkspace(workspaceId: string): boolean {
    for (const { win, workspace } of this._windows.values()) {
      const current = workspace.current
      if (current && workspaceIdFromUri(current.folder.toString()) === workspaceId) {
        if (!win.isDestroyed()) {
          if (win.isMinimized()) win.restore()
          win.focus()
        }
        return true
      }
    }
    return false
  }

  private _scheduleSessionPersist(): void {
    if (this._quitting) return
    if (this._sessionPersistTimer !== null) clearTimeout(this._sessionPersistTimer)
    this._sessionPersistTimer = setTimeout(() => {
      this._sessionPersistTimer = null
      void this._persistSessionNow()
    }, SESSION_PERSIST_DEBOUNCE_MS)
  }

  private async _persistSessionNow(): Promise<void> {
    if (this._sessionPersistTimer !== null) {
      clearTimeout(this._sessionPersistTimer)
      this._sessionPersistTimer = null
    }
    const list: IPersistedWindow[] = []
    for (const { win, workspace } of this._windows.values()) {
      if (win.isDestroyed()) continue
      list.push(
        serializeWindow(
          workspace.current,
          captureWindowState(win),
          win.webContents.isDevToolsOpened(),
        ),
      )
    }
    await getDefaultStorage().set(WINDOWS_SESSION_STORAGE_KEY, list)
  }

  dispose(): void {
    const logger = this._opts.logService.createLogger({ id: 'window', name: 'Window' })
    logger.info(`dispose windows=${this._windows.size}`)
    if (this._sessionPersistTimer !== null) {
      clearTimeout(this._sessionPersistTimer)
      this._sessionPersistTimer = null
    }
    for (const { disposables } of this._windows.values()) {
      disposables.dispose()
    }
    this._windows.clear()
    this._onDidChangeWindows.dispose()
  }
}
