/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  createWindowScopedServices: builds the per-window service stack for one
 *  BrowserWindow — its own workspace stack, storage, user-data, host, log
 *  channels, terminal, file watcher — plus the IPC bootstrap and cross-window
 *  session-switcher registration. Every window gets its own instances so opening
 *  a folder in one window never affects another; GLOBAL state stays on the shared
 *  app-singleton backends.
 *
 *  Extracted from WindowMainService.createWindow (roadmap 06 · task 2). The facade
 *  couplings (create a new window, look up a live renderer lifecycle, focus a
 *  window / a workspace's window) are passed in as callbacks so this stays a plain
 *  assembly function with no back-reference to the service.
 *--------------------------------------------------------------------------------------------*/

import type { BrowserWindow } from 'electron'
import { DisposableStore } from '@universe-editor/platform'
import type { IRendererLifecycleService } from '../../../shared/ipc/lifecycleService.js'
import { bootstrapWindowIpc } from '../../ipc/registerMainServices.js'
import { MainHostService } from '../host/hostMainService.js'
import { MainWindowsService } from './windowsMainService.js'
import { MainLogChannelService } from '../log/mainLogChannelService.js'
import { LogFilesMainService } from '../log/logFilesMainService.js'
import type { LogMainService } from '../log/logMainService.js'
import { MainStorageService } from '../storage/storageMainService.js'
import { WorkspaceMainService } from '../workspace/workspaceMainService.js'
import { UserDataMainService } from '../userData/userDataMainService.js'
import { TerminalMainService } from '../terminal/terminalMainService.js'
import { FileWatcherMainService } from '../fileWatcher/fileWatcherMainService.js'
import { ElectronFolderDialog } from '../workspace/electronFolderDialog.js'
import { getDefaultStorage } from '../../storage.js'
import type {
  ApplicationServices,
  WindowScopedServices,
} from '../../window/scopedServicesFactory.js'
import type { IWorkspace } from '@universe-editor/platform'
import type { WindowMainService } from './windowMainService.js'

/** Facade couplings the per-window stack needs, without a back-reference to it. */
export interface WindowScopeCallbacks {
  /** Open a fresh empty window (host "new window" affordance). */
  readonly createEmptyWindow: () => void
  /** The live renderer lifecycle for a window id, if it is still registered. */
  readonly getRendererLifecycle: (windowId: number) => IRendererLifecycleService | undefined
  /** Focus a window by id (cross-window session switcher target). */
  readonly focusWindow: (windowId: number) => void
  /** Focus the window already holding `workspaceId`; returns whether one existed. */
  readonly focusWindowForWorkspace: (workspaceId: string) => boolean
}

export interface WindowScopeResult {
  readonly disposables: DisposableStore
  readonly workspace: WorkspaceMainService
  readonly windowStorage: MainStorageService
  readonly rendererLifecycle: IRendererLifecycleService
}

/**
 * Construct the per-window service stack, bootstrap its IPC, and register it with
 * the cross-window session switcher. The caller owns `disposables` (dispose on
 * window close) and wires window-lifecycle events (persist, close veto) itself.
 */
export async function createWindowScopedServices(opts: {
  win: BrowserWindow
  appServices: ApplicationServices
  logService: LogMainService
  configDir: string
  isFirstWindow: boolean
  restoreWorkspace?: IWorkspace | null
  callbacks: WindowScopeCallbacks
  /** The owning service — needed only to back the cross-process IWindowsService adapter. */
  windowsServiceHost: WindowMainService
}): Promise<WindowScopeResult> {
  const {
    win,
    appServices,
    logService,
    configDir,
    isFirstWindow,
    restoreWorkspace,
    callbacks,
    windowsServiceHost,
  } = opts

  const disposables = new DisposableStore()
  const windowStorage = disposables.add(new MainStorageService(getDefaultStorage()))
  const folderDialog = new ElectronFolderDialog(win)
  const workspace = disposables.add(
    new WorkspaceMainService(
      windowStorage,
      appServices.recentWorkspaces,
      folderDialog,
      logService.createLogger({ id: 'workspace', name: 'Workspace' }),
      (workspaceId) => callbacks.focusWindowForWorkspace(workspaceId),
    ),
  )
  // Restore the workspace before loadURL so the renderer's getCurrent() at
  // startup already sees it (and the WORKSPACE scope is bound for editor restore).
  if (restoreWorkspace) {
    await workspace.restoreCurrent(restoreWorkspace)
  }
  const userData = disposables.add(new UserDataMainService(workspace, configDir))
  // Hot-reload user settings/keybindings when the config directory changes.
  disposables.add(appServices.configLocation.onDidChangeConfigDir((dir) => userData.relocate(dir)))
  const host = disposables.add(
    new MainHostService(
      win,
      () => callbacks.createEmptyWindow(),
      logService.createLogger({ id: 'host', name: 'Host' }),
      {
        getRendererLifecycle: () => callbacks.getRendererLifecycle(win.id),
      },
    ),
  )
  const logChannel = new MainLogChannelService(logService, win.id)
  const logFiles = new LogFilesMainService(logService, win.id)
  const terminal = disposables.add(new TerminalMainService(undefined, logService))
  const fileWatcher = disposables.add(new FileWatcherMainService(logService))
  const windowServices: WindowScopedServices = {
    host,
    logChannel,
    logFiles,
    storage: windowStorage,
    workspace,
    userData,
    terminal,
    fileWatcher,
  }

  const windowsService = disposables.add(new MainWindowsService(windowsServiceHost, isFirstWindow))
  const ipc = bootstrapWindowIpc(win, appServices, windowServices, windowsService)
  disposables.add(ipc.disposable)

  // Register this window with the cross-window session switcher so other windows'
  // Alt+S can list/reveal its sessions. Unregistered on `closed` (by the caller).
  appServices.sessionSwitcher.registerWindow(win.id, {
    rendererSessions: ipc.rendererSessions,
    getWorkspaceName: () => workspace.current?.name ?? '',
    focus: () => callbacks.focusWindow(win.id),
  })

  return { disposables, workspace, windowStorage, rendererLifecycle: ipc.rendererLifecycle }
}
