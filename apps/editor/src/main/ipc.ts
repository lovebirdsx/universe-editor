import { ipcMain } from 'electron'
import { IpcChannel } from '../shared/ipc-channels.js'
import { handlePing } from './handlers.js'

export function registerIpcHandlers(): void {
  ipcMain.handle(IpcChannel.Ping, (_event, rendererSentAt: number) => handlePing(rendererSentAt))
}
