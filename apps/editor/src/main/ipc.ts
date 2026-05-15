import { BrowserWindow, ipcMain } from 'electron'
import { IpcChannel } from '../shared/ipc-channels.js'
import { handlePing } from './handlers.js'
import { getDefaultStorage } from './storage.js'

export function registerIpcHandlers(): void {
  ipcMain.handle(IpcChannel.Ping, (_event, rendererSentAt: number) => handlePing(rendererSentAt))

  ipcMain.handle(IpcChannel.StorageGet, (_event, key: string) => getDefaultStorage().get(key))
  ipcMain.handle(IpcChannel.StorageSet, (_event, key: string, value: unknown) =>
    getDefaultStorage().set(key, value),
  )
  ipcMain.handle(IpcChannel.WindowMinimize, (e) => {
    BrowserWindow.fromWebContents(e.sender)?.minimize()
  })

  ipcMain.handle(IpcChannel.WindowMaximize, (e) => {
    const win = BrowserWindow.fromWebContents(e.sender)
    if (win) {
      if (win.isMaximized()) win.unmaximize()
      else win.maximize()
    }
  })

  ipcMain.handle(IpcChannel.WindowClose, (e) => {
    BrowserWindow.fromWebContents(e.sender)?.close()
  })

  ipcMain.handle(IpcChannel.WindowIsMaximized, (e) => {
    return BrowserWindow.fromWebContents(e.sender)?.isMaximized() ?? false
  })
}
