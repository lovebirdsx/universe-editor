/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  WindowMainService: owns the full lifecycle of BrowserWindows — creation,
 *  IPC bootstrap, state tracking, and disposal. Also owns the multi-window
 *  session list: which windows (workspace + geometry + devtools) were open, so
 *  the app can restore them on next launch.
 *--------------------------------------------------------------------------------------------*/

import { BrowserWindow, dialog, shell } from 'electron'
import { basename } from 'node:path'
import { homedir } from 'node:os'
import {
  DisposableStore,
  Emitter,
  isEqualOrParentResource,
  localize,
  mark,
  normalizePlatform,
  ShutdownReason,
  URI,
  type Event,
  type IDisposable,
  type IOpenWindowInfo,
  type IWindowRenderCrashInfo,
  type ShutdownConfirmationContext,
  type IWorkspace,
} from '@universe-editor/platform'
import { E2E_PROBE_ARGV_FLAG } from '../../../shared/e2e/contract.js'
import { EXTENSION_DEVELOPMENT_ARGV_FLAG } from '../../../shared/extensionDevelopment.js'
import { PerfMarks } from '../../../shared/perf/marks.js'
import { APP_PROTOCOL_SCHEME, APP_SHELL_URL } from '../../ipc/resourceProtocol.js'
import { type IRendererLifecycleService } from '../../../shared/ipc/lifecycleService.js'
import { type LogMainService } from '../log/logMainService.js'
import { WorkspaceMainService } from '../workspace/workspaceMainService.js'
import { applyWindowState, trackWindowState, type IWindowState } from '../../windowState.js'
import { observeDevToolsState } from '../../devToolsState.js'
import { getDefaultStorage, workspaceIdFromUri } from '../../storage.js'
import { loadWorkspaceGeometry, type IRestoreWindow } from '../../windowsSession.js'
import { normalizeRemoteUri } from '../remote/remoteUri.js'
import { deriveWindowRemoteAuthority } from './windowRemoteAuthority.js'
import { WindowSessionStore } from './windowSessionStore.js'
import { createWindowScopedServices } from './windowScopeFactory.js'
import { processRoleRegistry } from '../process/processRoleRegistry.js'
import type { ApplicationServices } from '../../window/scopedServicesFactory.js'

export interface ICreateWindowOptions {
  /** Workspace to restore into this window (session restore). Undefined/null → empty window. */
  readonly workspace?: IWorkspace | null
  /** Window geometry to restore. */
  readonly uiState?: IWindowState
  /** Whether DevTools should be opened. */
  readonly devToolsOpen?: boolean
  /** Absolute file path to open in the editor at startup (e.g. from CLI double-click). */
  readonly fileToOpen?: string
  /** ACP session id the renderer should resume once it is up (cross-worktree follow). */
  readonly sessionToOpen?: string
  /** A `universe-editor://` deep link (as an opener-target string) to open at startup. */
  readonly deepLink?: string
  /** remote-ssh authority to scope an empty window to; a workspace folder wins when both are given. */
  readonly remoteAuthority?: string
}

export interface IWindowMainService {
  readonly onDidChangeWindows: Event<void>
  createWindow(opts?: ICreateWindowOptions): Promise<number>
  restoreSession(list: readonly IRestoreWindow[], fileToOpen?: string): Promise<void>
  focusWindow(id: number): void
  getWindowById(id: number): BrowserWindow | undefined
  getWindows(): ReadonlyArray<BrowserWindow>
  getOpenWindowInfos(): IOpenWindowInfo[]
  openWindowForFolder(folder?: URI, sessionToOpen?: string, deepLink?: string): Promise<void>
  captureSessionForQuit(): Promise<void>
  confirmQuit(requestingWindowId?: number): Promise<boolean>
  isQuitConfirmed(): boolean
  dispose(): void
}

interface WindowEntry {
  readonly win: BrowserWindow
  readonly workspace: WorkspaceMainService
  readonly disposables: DisposableStore
  readonly rendererLifecycle: IRendererLifecycleService
  /** Window-level remote authority (empty windows only; a workspace folder wins). */
  readonly remoteAuthority: string | undefined
}

export interface WindowMainServiceOptions {
  readonly appServices: ApplicationServices
  readonly logService: LogMainService
  readonly e2eEnabled: boolean
  /** E2E 静默模式：窗口 showInactive 而非抢前台焦点（UNIVERSE_E2E_SHOW=1 关闭，恢复有头调试）。 */
  readonly silentE2E: boolean
  /** Extension-development host instance (--extension-development-path present). */
  readonly extensionDevelopment: boolean
  /** Delay renderer load so VS Code's Chrome debugger can attach (dev only). */
  readonly rendererDebug: boolean
  /** Absolute path to app icon (.ico on Windows). */
  readonly appIconPath?: string
  /** Absolute path to the preload script. */
  readonly preloadPath: string
  /** electron-vite dev server URL (undefined in production). */
  readonly rendererUrl: string | undefined
  /** Resolved directory for user settings/keybindings (EnvironmentMainService.configDir). */
  readonly getConfigDir: () => string
}

// Upper bound on the renderer's shutdown-veto round-trip. Long enough for a busy
// but healthy renderer to answer a confirm dialog; short enough that a wedged one
// can't stall quit indefinitely. On timeout the veto is released (app proceeds).
const CONFIRM_SHUTDOWN_TIMEOUT_MS = 10_000

export class WindowMainService implements IWindowMainService {
  private readonly _windows = new Map<number, WindowEntry>()
  private _quitting = false
  /** Set once a quit has been confirmed (renderer cleared, or a restart path
   *  already confirmed) so before-quit doesn't prompt a second time. */
  private _quitConfirmed = false
  /** Window ids cleared to close — set after a confirmed close/quit so the
   *  close handler bypasses the renderer veto round-trip on the second pass. */
  private readonly _allowClose = new Set<number>()
  /** Window ids with a crash-recovery dialog currently showing, so a crash storm
   *  never stacks multiple prompts. Cleared when the dialog resolves. */
  private readonly _crashHandled = new Set<number>()
  /**
   * Most recent unexpected renderer exit per window (any render-process-gone
   * reason except clean-exit). Read back by the reloaded renderer through
   * `IWindowsService.getLastRenderCrash` so it can break crash loops (e.g. an
   * OOMing session restore). In-memory only — a real app restart resets it.
   */
  private readonly _lastRenderCrash = new Map<number, IWindowRenderCrashInfo>()
  private readonly _sessionStore = new WindowSessionStore(() => this._windows.values())
  private _hasCreatedFirstWindow = false

  private readonly _onDidChangeWindows = new Emitter<void>()
  readonly onDidChangeWindows: Event<void> = this._onDidChangeWindows.event

  constructor(private readonly _opts: WindowMainServiceOptions) {}

  async createWindow(opts?: ICreateWindowOptions): Promise<number> {
    const {
      e2eEnabled,
      extensionDevelopment,
      rendererDebug,
      appIconPath,
      preloadPath,
      rendererUrl,
      appServices,
      logService,
    } = this._opts
    const logger = logService.createLogger({ id: 'window', name: 'Window' })
    const isFirstWindow = !this._hasCreatedFirstWindow
    this._hasCreatedFirstWindow = true

    const isMac = process.platform === 'darwin'
    const uiState = opts?.uiState
    const windowRemoteAuthority = deriveWindowRemoteAuthority(
      opts?.workspace?.folder ?? undefined,
      opts?.remoteAuthority,
    )
    logger.info(
      `createWindow start e2e=${e2eEnabled} dev=${rendererUrl !== undefined} restoredState=${uiState !== undefined} workspace=${opts?.workspace?.folder.toString() ?? '<none>'} remoteAuthority=${windowRemoteAuthority ?? '<none>'}`,
    )
    if (this._opts.silentE2E) {
      logger.info(
        'e2e silent: window shown inactive (UNIVERSE_E2E_SHOW=1 restores foreground focus)',
      )
    }
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
        // Dev only: the shell is served from http://localhost, so a
        // universe-app:// preview image is cross-origin and Chromium blocks it
        // before it reaches our handler. Relax web security in dev to allow it.
        // Prod serves the shell on universe-app:// itself, so images are
        // same-origin and this stays on.
        ...(rendererUrl ? { webSecurity: false } : {}),
        // VSCode parity (vs/platform/windows/electron-main/windowImpl.ts):
        // Chromium background throttling is OFF for every window — a hidden
        // renderer's timers freeze and every host↔renderer RPC chain stalls
        // silently otherwise (the 2026-08 swarm-notification incident: 2.5h of
        // dropped polls while the window sat occluded). rAF already pauses on
        // hidden (visibility-governed, not throttling-governed) and the resident
        // timers are 60s-class polls, so the CPU/battery cost is negligible.
        // UNIVERSE_E2E_THROTTLE=1 opts back INTO throttling for specs that
        // explicitly verify throttled-window behavior.
        ...(process.env['UNIVERSE_E2E_THROTTLE'] ? {} : { backgroundThrottling: false }),
        additionalArguments: [
          `--ue-home-dir=${homedir()}`,
          ...(opts?.fileToOpen ? [`--ue-open-file=${opts.fileToOpen}`] : []),
          ...(opts?.sessionToOpen ? [`--ue-open-session=${opts.sessionToOpen}`] : []),
          ...(opts?.deepLink ? [`--ue-open-uri=${opts.deepLink}`] : []),
          ...(windowRemoteAuthority ? [`--ue-remote-authority=${windowRemoteAuthority}`] : []),
          ...(e2eEnabled ? [E2E_PROBE_ARGV_FLAG] : []),
          ...(extensionDevelopment ? [EXTENSION_DEVELOPMENT_ARGV_FLAG] : []),
        ],
      },
    })

    win.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith('https://') || url.startsWith('http://')) {
        void shell.openExternal(url)
      }
      return { action: 'deny' }
    })

    // reload / 崩溃重建会换掉渲染进程（pid 变），load 完成后重登记；
    // 崩溃后未 reload 前旧 pid 已死，先在 render-process-gone 里摘除。
    let roleRegistration: IDisposable | undefined
    const registerRendererRole = (): void => {
      roleRegistration?.dispose()
      roleRegistration = undefined
      roleRegistration = processRoleRegistry.register(win.webContents.getOSProcessId(), {
        role: 'window',
        label: `window-${win.id}`,
      })
    }
    registerRendererRole()
    win.webContents.on('did-finish-load', registerRendererRole)

    win.webContents.on('will-navigate', (event, url) => {
      // Allow in-app navigation on the shell's own origins (file:// dev fallback,
      // http:// dev server, and the prod universe-app:// scheme); block the rest.
      if (
        !url.startsWith('file:') &&
        !url.startsWith('http:') &&
        !url.startsWith(`${APP_PROTOCOL_SCHEME}:`)
      ) {
        event.preventDefault()
      }
    })

    // Renderer freeze floor: when the renderer hangs so hard that its own
    // monitors (Event Timing / LoAF) cannot even run, Chromium flags the
    // webContents unresponsive. Log-only — Windows lock/suspend can trigger
    // false unresponsive blips, and a dialog would compound the annoyance;
    // the responsive pairing below carries the recovery duration instead.
    let unresponsiveSince: number | undefined
    win.webContents.on('unresponsive', () => {
      unresponsiveSince = Date.now()
      logger.error(`renderer unresponsive id=${win.id}`)
    })
    win.webContents.on('responsive', () => {
      const recoveredMs = unresponsiveSince === undefined ? -1 : Date.now() - unresponsiveSince
      unresponsiveSince = undefined
      logger.warn(`renderer responsive again id=${win.id} after ${recoveredMs}ms`)
    })

    // Renderer crash recovery. A dead renderer leaves the window frame drawable
    // (draggable) but blank — the content process is gone. Without this the user
    // is stuck at a black window with no way back. `clean-exit` is a normal
    // teardown (e.g. reload) and must be ignored; anything else (crashed / oom /
    // killed) offers a one-click reload. `_crashHandled` de-bounces the dialog so
    // a crash storm never stacks multiple prompts. E2E skips the native modal —
    // it would block the driver; a crash there must fail the test, not stall it.
    win.webContents.on('render-process-gone', (_event, details) => {
      if (details.reason === 'clean-exit') return
      this._lastRenderCrash.set(win.id, { reason: details.reason, at: Date.now() })
      roleRegistration?.dispose()
      roleRegistration = undefined
      const line = `render-process-gone id=${win.id} reason=${details.reason} exitCode=${details.exitCode ?? 'n/a'}`
      logger.error(line)
      appServices.errorSink.recordLocal('renderProcessGone', line, `renderer:${win.id}`)
      if (e2eEnabled) return
      if (this._crashHandled.has(win.id)) return
      this._crashHandled.add(win.id)
      if (win.isDestroyed()) return
      void dialog
        .showMessageBox(win, {
          type: 'error',
          buttons: [localize('crash.reload', 'Reload'), localize('crash.close', 'Close Window')],
          defaultId: 0,
          cancelId: 1,
          title: localize('crash.title', 'The editor window has crashed'),
          message: localize('crash.title', 'The editor window has crashed'),
          detail: localize(
            'crash.detail',
            'The renderer process exited unexpectedly ({reason}). Reloading restores the window; any ongoing tasks may have been interrupted.',
            { reason: details.reason },
          ),
        })
        .then((result) => {
          this._crashHandled.delete(win.id)
          if (win.isDestroyed()) return
          if (result.response === 0) {
            logger.info(`crash reload id=${win.id}`)
            win.reload()
          } else {
            logger.info(`crash close id=${win.id}`)
            this._allowClose.add(win.id)
            win.close()
          }
        })
        .catch(() => {
          this._crashHandled.delete(win.id)
        })
    })

    win.once('ready-to-show', () => {
      if (uiState) applyWindowState(win, uiState)
      if (this._opts.silentE2E) win.showInactive()
      else win.show()
      if (opts?.devToolsOpen) win.webContents.openDevTools()
      mark(PerfMarks.mainDidShowWindow)
      logger.info(`readyToShow id=${win.id} silent=${this._opts.silentE2E}`)
    })

    // Per-window services — each window gets its own workspace stack so opening
    // a folder in one window does not affect the others. GLOBAL state (state.json,
    // recent list) stays shared via the app-singleton backends.
    const { disposables, workspace, windowStorage, rendererLifecycle } =
      await createWindowScopedServices({
        win,
        appServices,
        logService,
        configDir: this._opts.getConfigDir(),
        isFirstWindow,
        ...(opts?.workspace !== undefined ? { restoreWorkspace: opts.workspace } : {}),
        windowsServiceHost: this,
        callbacks: {
          createEmptyWindow: (options) => {
            void this.createWindow(
              options?.remoteAuthority ? { remoteAuthority: options.remoteAuthority } : {},
            )
          },
          getRendererLifecycle: (windowId) => this._windows.get(windowId)?.rendererLifecycle,
          focusWindow: (windowId) => this.focusWindow(windowId),
          focusWindowForWorkspace: (workspaceId) => this._focusWindowForWorkspace(workspaceId),
        },
      })

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
      rendererLifecycle,
      remoteAuthority: windowRemoteAuthority,
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
        const tasks: Promise<void>[] = [windowStorage.flush()]
        // Capture this window's FINAL geometry into the session now, while it is
        // still live and registered. `close` is the last synchronous moment the
        // window's bounds/fullscreen state are readable (captureWindowState fails
        // once destroyed). Without this, closing the last window loses its final
        // fullscreen/maximized state: the trackWindowState debounce is cancelled
        // by dispose() below, the closed handler skips persist at size 0, and
        // captureSessionForQuit is likewise a no-op — so the restore list keeps a
        // stale pre-fullscreen snapshot. The synchronous capture inside
        // _persistSessionNow runs before the window is torn down; only the write
        // is async. Skip while quitting: captureSessionForQuit already snapshotted
        // the full window set, and per-window persist here could race the closed
        // handlers into shrinking that list.
        if (!this._quitting) tasks.push(this._persistSessionNow())
        // Dispose the per-window resources SYNCHRONOUSLY. Deferring this behind
        // the flush/persist promise chain loses the race on quit: `closed` removes
        // the entry from `_windows` immediately, so will-quit's dispose() finds it
        // gone, and process.exit fires before the `.finally` runs — leaking every
        // per-window Disposable. Flushing reads only already-captured in-memory
        // state, so it stays correct after dispose().
        void Promise.all(tasks)
        disposables.dispose()
        return
      }
      e.preventDefault()
      void this._confirmAndClose(entry)
    })
    win.on('closed', () => {
      roleRegistration?.dispose()
      this._windows.delete(win.id)
      this._allowClose.delete(win.id)
      this._crashHandled.delete(win.id)
      this._lastRenderCrash.delete(win.id)
      this._opts.appServices.sessionSwitcher.unregisterWindow(win.id)
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
      // Prod: serve the shell over the custom app scheme (not file://) so the page
      // shares an origin with universe-app://resource/... — a file:// page cannot
      // load a different custom scheme, which is what markdown-preview images need.
      logger.info(`loadURL id=${win.id} url=${APP_SHELL_URL}`)
      void win.loadURL(APP_SHELL_URL).catch((err) => {
        logger.error(`loadURL(app shell) failed id=${win.id}`, err)
      })
    }

    return win.id
  }

  /**
   * Restore a previously persisted session. Opens one window per entry (skipping
   * duplicate workspaces defensively). An empty list opens a single empty window.
   * When `fileToOpen` is given, it is routed to whichever window's workspace
   * contains the file; if none match, the first window receives it.
   */
  async restoreSession(list: readonly IRestoreWindow[], fileToOpen?: string): Promise<void> {
    if (list.length === 0) {
      await this.createWindow(fileToOpen ? { fileToOpen } : {})
      return
    }

    // The file (if any) is routed to the first window whose workspace contains it.
    const fileUri = fileToOpen ? URI.file(fileToOpen) : undefined

    const seen = new Set<string>()
    let fileAssigned = false
    let isFirst = true

    for (const entry of list) {
      const id = entry.workspace ? workspaceIdFromUri(entry.workspace.folder.toString()) : null
      if (id !== null) {
        if (seen.has(id)) continue
        seen.add(id)
      }

      // Decide whether to route the file to this window.
      let windowFileToOpen: string | undefined
      if (fileToOpen && !fileAssigned) {
        if (fileUri && entry.workspace) {
          if (
            isEqualOrParentResource(
              fileUri,
              entry.workspace.folder,
              normalizePlatform(process.platform),
            )
          ) {
            windowFileToOpen = fileToOpen
            fileAssigned = true
          }
        }
        // Fallback: assign to the first window if no workspace matched yet.
        if (!windowFileToOpen && isFirst) {
          windowFileToOpen = fileToOpen
          fileAssigned = true
        }
      }

      await this.createWindow({
        workspace: entry.workspace,
        ...(entry.uiState ? { uiState: entry.uiState } : {}),
        devToolsOpen: entry.devToolsOpen,
        ...(windowFileToOpen ? { fileToOpen: windowFileToOpen } : {}),
        ...(entry.remoteAuthority ? { remoteAuthority: entry.remoteAuthority } : {}),
      })
      isFirst = false
    }
  }

  focusWindow(id: number): void {
    const entry = this._windows.get(id)
    if (entry && !entry.win.isDestroyed()) {
      if (this._opts.silentE2E) entry.win.showInactive()
      else entry.win.focus()
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

  getLastRenderCrash(windowId: number): IWindowRenderCrashInfo | null {
    return this._lastRenderCrash.get(windowId) ?? null
  }

  /**
   * Open a window for `folder`. When omitted, prompt with a native folder picker
   * first. If the folder is already open in some window, focus it instead of
   * creating a duplicate (single-writer-per-workspace constraint).
   *
   * `sessionToOpen` (optional) is an ACP session id the window should resume once
   * it is up: passed via argv to a freshly created window, or pushed over the
   * `ue:open-session` IPC channel when an existing window is focused instead.
   *
   * `deepLink` (optional) is an opener-target string the window should open once
   * it is up: passed via argv to a freshly created window, or pushed over the
   * `ue:open-uri` IPC channel when an existing window is focused instead. Used by
   * agent deep links, which must land in the workspace matching their `cwd`.
   */
  async openWindowForFolder(
    folder?: URI,
    sessionToOpen?: string,
    deepLink?: string,
  ): Promise<void> {
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
    resolved = normalizeRemoteUri(resolved)
    const workspace: IWorkspace = {
      folder: resolved,
      name: basename(resolved.fsPath) || resolved.fsPath,
    }
    const workspaceId = workspaceIdFromUri(workspace.folder.toString())
    const existing = this._findWindowForWorkspace(workspaceId)
    if (existing) {
      if (!existing.win.isDestroyed()) {
        if (existing.win.isMinimized()) existing.win.restore()
        if (this._opts.silentE2E) existing.win.showInactive()
        else existing.win.focus()
        if (sessionToOpen) existing.win.webContents.send('ue:open-session', sessionToOpen)
        if (deepLink) existing.win.webContents.send('ue:open-uri', deepLink)
        await this._opts.appServices.recentWorkspaces.add(workspace)
      }
      return
    }
    // WorkspaceMainService.restoreCurrent() (invoked by createWindow below) bumps
    // the shared recent list itself, so no need to add() again here.
    // Restore the geometry this workspace was last seen at, so reopening a closed
    // folder returns to where the user left it (falls back to default if none).
    const uiState = await loadWorkspaceGeometry(getDefaultStorage(), workspaceId)
    await this.createWindow({
      workspace,
      ...(uiState ? { uiState } : {}),
      ...(sessionToOpen ? { sessionToOpen } : {}),
      ...(deepLink ? { deepLink } : {}),
    })
  }

  /**
   * Snapshot the full session right before the app quits, before windows start
   * closing (which would otherwise shrink the persisted list). Awaits the write
   * so the caller in before-quit can guarantee durability before app.quit().
   */
  async captureSessionForQuit(): Promise<void> {
    this._quitting = true
    if (this._windows.size > 0) await this._persistSessionNow()
  }

  /**
   * Ask the renderer whether the app may quit. Polls every window's lifecycle
   * veto chain; a single veto aborts the quit. On success, marks every window
   * as cleared so their close handlers bypass the per-window confirm.
   */
  async confirmQuit(requestingWindowId?: number): Promise<boolean> {
    if (requestingWindowId !== undefined) {
      const requestingWindow = this._windows.get(requestingWindowId)
      if (requestingWindow && !requestingWindow.win.isDestroyed()) {
        const sessions = await this._opts.appServices.sessionSwitcher.getAllSessions()
        // 'background' = turn settled but run_in_background tasks still executing;
        // quitting kills the agent process and that work with it, so count it.
        const runningSessionCount = sessions.filter(
          (session) => session.status === 'running' || session.status === 'background',
        ).length
        this._opts.logService
          .createLogger({ id: 'window', name: 'Window' })
          .info(
            `confirmQuit requester=${requestingWindowId} runningSessions=${runningSessionCount}`,
          )
        if (
          !(await this._canProceed(
            requestingWindowId,
            requestingWindow.rendererLifecycle,
            ShutdownReason.Quit,
            {
              runningSessionCount,
            },
          ))
        ) {
          return false
        }
        for (const [windowId, { win, rendererLifecycle }] of this._windows) {
          if (windowId === requestingWindowId || win.isDestroyed()) continue
          if (
            !(await this._canProceed(windowId, rendererLifecycle, ShutdownReason.Quit, {
              skipRunningSessionPrompt: true,
            }))
          ) {
            return false
          }
        }
        this.markQuitConfirmed()
        return true
      }
    }

    for (const { win, rendererLifecycle } of this._windows.values()) {
      if (win.isDestroyed()) continue
      if (!(await this._canProceed(win.id, rendererLifecycle, ShutdownReason.Quit))) return false
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
    const proceed = await this._canProceed(
      entry.win.id,
      entry.rendererLifecycle,
      ShutdownReason.CloseWindow,
    )
    if (!proceed) return
    this._allowClose.add(entry.win.id)
    if (!entry.win.isDestroyed()) entry.win.close()
  }

  /** Ask the renderer; treat an unreachable renderer / error / timeout as "proceed". */
  private async _canProceed(
    windowId: number,
    rendererLifecycle: IRendererLifecycleService,
    reason: ShutdownReason,
    context?: ShutdownConfirmationContext,
  ): Promise<boolean> {
    // A wedged renderer (e.g. a hung JS main thread) may never answer the veto
    // round-trip. The IPC channel only rejects on window teardown, so without a
    // timeout here the quit/close flow would hang silently forever. Bound the
    // wait and treat a non-answer as "release the veto" — an unresponsive
    // renderer must not be able to block the app from quitting.
    const confirm = rendererLifecycle.confirmShutdown(reason, context)
    // If the timeout wins the race, a late rejection from the renderer (e.g. the
    // channel disposed during window teardown) would surface as an unhandled
    // rejection — the race no longer observes it.
    void confirm.catch(() => undefined)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        confirm,
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => {
            this._opts.logService
              .createLogger({ id: 'window', name: 'Window' })
              .warn(
                `confirmShutdown timed out after ${CONFIRM_SHUTDOWN_TIMEOUT_MS}ms id=${windowId} reason=${reason}; proceeding`,
              )
            resolve(true)
          }, CONFIRM_SHUTDOWN_TIMEOUT_MS)
        }),
      ])
    } catch {
      return true
    } finally {
      // The renderer answered (or the channel rejected) before the deadline:
      // cancel the timer so it cannot fire later and log a phantom timeout for
      // a round-trip that actually succeeded.
      clearTimeout(timer)
    }
  }

  /**
   * If a window already has the given workspace open, focus it and return true;
   * otherwise return false. Used to avoid opening the same folder in two windows
   * (which would also race on the same workspaces/<id>.json backend).
   */
  private _focusWindowForWorkspace(workspaceId: string): boolean {
    const entry = this._findWindowForWorkspace(workspaceId)
    if (!entry) return false
    if (!entry.win.isDestroyed()) {
      if (entry.win.isMinimized()) entry.win.restore()
      if (this._opts.silentE2E) entry.win.showInactive()
      else entry.win.focus()
    }
    return true
  }

  /** Locate the (live) window entry whose workspace matches `workspaceId`, if any. */
  private _findWindowForWorkspace(workspaceId: string): WindowEntry | undefined {
    for (const entry of this._windows.values()) {
      const current = entry.workspace.current
      if (current && workspaceIdFromUri(current.folder.toString()) === workspaceId) {
        return entry
      }
    }
    return undefined
  }

  private _scheduleSessionPersist(): void {
    if (this._quitting) return
    this._sessionStore.schedule()
  }

  private _persistSessionNow(): Promise<void> {
    return this._sessionStore.persistNow()
  }

  dispose(): void {
    const logger = this._opts.logService.createLogger({ id: 'window', name: 'Window' })
    logger.info(`dispose windows=${this._windows.size}`)
    this._sessionStore.cancel()
    for (const { disposables } of this._windows.values()) {
      disposables.dispose()
    }
    this._windows.clear()
    this._onDidChangeWindows.dispose()
  }
}
