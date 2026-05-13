import { contextBridge, ipcRenderer } from 'electron'
import { IpcChannel, type PingResult } from '../shared/ipc-channels.js'

const api = {
  ping: (rendererSentAt: number): Promise<PingResult> =>
    ipcRenderer.invoke(IpcChannel.Ping, rendererSentAt),
}

contextBridge.exposeInMainWorld('api', api)

export type EditorApi = typeof api
