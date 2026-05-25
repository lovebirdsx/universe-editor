import type { BrowserWindow } from 'electron'
import type { Storage } from './storage.js'

const STORAGE_KEY = 'window.devToolsOpen'

export async function loadDevToolsOpen(storage: Storage): Promise<boolean> {
  const raw = await storage.get<boolean>(STORAGE_KEY)
  return raw === true
}

export function trackDevToolsState(win: BrowserWindow, storage: Storage): void {
  win.webContents.on('devtools-opened', () => {
    void storage.set(STORAGE_KEY, true)
  })
  win.webContents.on('devtools-closed', () => {
    void storage.set(STORAGE_KEY, false)
  })
}
