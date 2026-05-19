/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  WindowMainService: owns the full lifecycle of BrowserWindows — creation,
 *  IPC bootstrap, state tracking, and disposal. Replaces the scattered
 *  `createWindow()` / `sharedServices` globals in main/index.ts.
 *--------------------------------------------------------------------------------------------*/

import { BrowserWindow } from 'electron'
import { localize, type IDisposable } from '@universe-editor/platform'
import { E2E_PROBE_ARGV_FLAG } from '../../../shared/e2e/contract.js'
import { bootstrapWindowIpc } from '../../ipc/registerMainServices.js'
import { MainHostService } from '../host/hostMainService.js'
import { MainLogChannelService, type LogMainService } from '../log/logMainService.js'
import { applyWindowState, loadWindowState, trackWindowState } from '../../windowState.js'
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
    const { e2eEnabled, preloadPath, rendererUrl, rendererHtml, appServices, logService } =
      this._opts

    const isMac = process.platform === 'darwin'
    const storage = getDefaultStorage()
    const windowState = await loadWindowState(storage)

    const win = new BrowserWindow({
      width: windowState?.width ?? 1280,
      height: windowState?.height ?? 800,
      ...(windowState ? { x: windowState.x, y: windowState.y } : {}),
      show: false,
      backgroundColor: '#1e1e1e',
      title: localize('app.name', 'Universe Editor'),
      ...(isMac
        ? { titleBarStyle: 'hidden' as const, trafficLightPosition: { x: 8, y: 8 } }
        : { frame: false }),
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        ...(e2eEnabled ? { additionalArguments: [E2E_PROBE_ARGV_FLAG] } : {}),
      },
    })

    win.once('ready-to-show', () => {
      if (windowState) applyWindowState(win, windowState)
      win.show()
    })

    trackWindowState(win, storage)

    // Per-window services
    const host = new MainHostService(win, () => {
      void this.createWindow()
    })
    const logChannel = new MainLogChannelService(logService)
    const windowServices: WindowScopedServices = { host, logChannel }

    const ipc = bootstrapWindowIpc(win, appServices, windowServices)
    const entry: WindowEntry = { win, ipc }
    this._windows.set(win.id, entry)

    win.on('closed', () => {
      ipc.dispose()
      this._windows.delete(win.id)
    })

    if (rendererUrl) {
      void win.loadURL(rendererUrl)
    } else {
      void win.loadFile(rendererHtml)
    }

    return win.id
  }

  focusWindow(id: number): void {
    const entry = this._windows.get(id)
    if (entry && !entry.win.isDestroyed()) {
      entry.win.focus()
    }
  }

  getWindowById(id: number): BrowserWindow | undefined {
    return this._windows.get(id)?.win
  }

  getWindows(): ReadonlyArray<BrowserWindow> {
    return Array.from(this._windows.values()).map((e) => e.win)
  }

  dispose(): void {
    for (const { ipc } of this._windows.values()) {
      ipc.dispose()
    }
    this._windows.clear()
  }
}
