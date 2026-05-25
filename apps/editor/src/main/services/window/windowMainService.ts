/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  WindowMainService: owns the full lifecycle of BrowserWindows — creation,
 *  IPC bootstrap, state tracking, and disposal. Replaces the scattered
 *  `createWindow()` / `sharedServices` globals in main/index.ts.
 *--------------------------------------------------------------------------------------------*/

import { BrowserWindow } from 'electron'
import { homedir } from 'node:os'
import { localize, type IDisposable } from '@universe-editor/platform'
import { E2E_PROBE_ARGV_FLAG } from '../../../shared/e2e/contract.js'
import { bootstrapWindowIpc } from '../../ipc/registerMainServices.js'
import { MainHostService } from '../host/hostMainService.js'
import { MainLogChannelService } from '../log/mainLogChannelService.js'
import { type LogMainService } from '../log/logMainService.js'
import { applyWindowState, loadWindowState, trackWindowState } from '../../windowState.js'
import { loadDevToolsOpen, trackDevToolsState } from '../../devToolsState.js'
import { getDefaultStorage } from '../../storage.js'
import type {
  ApplicationServices,
  WindowScopedServices,
} from '../../window/scopedServicesFactory.js'

export interface IWindowMainService {
  createWindow(): Promise<number>
  focusWindow(id: number): void
  getWindowById(id: number): BrowserWindow | undefined
  getWindows(): ReadonlyArray<BrowserWindow>
  dispose(): void
}

interface WindowEntry {
  readonly win: BrowserWindow
  readonly ipc: IDisposable
}

export interface WindowMainServiceOptions {
  readonly appServices: ApplicationServices
  readonly logService: LogMainService
  readonly e2eEnabled: boolean
  /** Absolute path to app icon (.ico on Windows). */
  readonly appIconPath?: string
  /** Absolute path to the preload script. */
  readonly preloadPath: string
  /** electron-vite dev server URL (undefined in production). */
  readonly rendererUrl: string | undefined
  /** Absolute path to renderer/index.html (production). */
  readonly rendererHtml: string
}

export class WindowMainService implements IWindowMainService {
  private readonly _windows = new Map<number, WindowEntry>()

  constructor(private readonly _opts: WindowMainServiceOptions) {}

  async createWindow(): Promise<number> {
    const {
      e2eEnabled,
      appIconPath,
      preloadPath,
      rendererUrl,
      rendererHtml,
      appServices,
      logService,
    } = this._opts
    const logger = logService.createLogger({ id: 'window', name: 'Window' })

    const isMac = process.platform === 'darwin'
    const storage = getDefaultStorage()
    const windowState = await loadWindowState(storage)
    const devToolsOpen = await loadDevToolsOpen(storage)
    logger.info(
      `createWindow start e2e=${e2eEnabled} dev=${rendererUrl !== undefined} restoredState=${windowState !== null}`,
    )

    const win = new BrowserWindow({
      width: windowState?.width ?? 1280,
      height: windowState?.height ?? 800,
      ...(windowState ? { x: windowState.x, y: windowState.y } : {}),
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
      if (windowState) applyWindowState(win, windowState)
      win.show()
      if (devToolsOpen) win.webContents.openDevTools()
      logger.info(`readyToShow id=${win.id}`)
    })

    trackWindowState(win, storage)
    trackDevToolsState(win, storage)

    // Per-window services
    const host = new MainHostService(
      win,
      () => {
        void this.createWindow()
      },
      logService.createLogger({ id: 'host', name: 'Host' }),
    )
    const logChannel = new MainLogChannelService(logService)
    const windowServices: WindowScopedServices = { host, logChannel }

    const ipc = bootstrapWindowIpc(win, appServices, windowServices)
    const entry: WindowEntry = { win, ipc }
    this._windows.set(win.id, entry)
    logger.info(`createWindow created id=${win.id}`)

    win.on('closed', () => {
      ipc.dispose()
      this._windows.delete(win.id)
      logger.info(`closed id=${win.id}`)
    })

    if (rendererUrl) {
      if (process.env['VSCODE_RENDERER_DEBUG'] === '1') {
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

  dispose(): void {
    const logger = this._opts.logService.createLogger({ id: 'window', name: 'Window' })
    logger.info(`dispose windows=${this._windows.size}`)
    for (const { ipc } of this._windows.values()) {
      ipc.dispose()
    }
    this._windows.clear()
  }
}
