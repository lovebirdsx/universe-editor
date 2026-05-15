import { ipcMain } from 'electron'
import { IpcChannel } from '../shared/ipc-channels.js'
import { handlePing } from './handlers.js'
import { getDefaultStorage } from './storage.js'

export function registerIpcHandlers(): void {
  ipcMain.handle(IpcChannel.Ping, (_event, rendererSentAt: number) => handlePing(rendererSentAt))

  ipcMain.handle(IpcChannel.StorageGet, (_event, key: string) => getDefaultStorage().get(key))
  ipcMain.handle(IpcChannel.StorageSet, (_event, key: string, value: unknown) =>
    getDefaultStorage().set(key, value),
  )
}
