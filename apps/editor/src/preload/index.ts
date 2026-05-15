import { contextBridge, ipcRenderer } from 'electron'
import { IpcChannel, type PingResult } from '../shared/ipc-channels.js'

const api = {
  ping: (rendererSentAt: number): Promise<PingResult> =>
    ipcRenderer.invoke(IpcChannel.Ping, rendererSentAt),
  storage: {
    get: <T = unknown>(key: string): Promise<T | undefined> =>
      ipcRenderer.invoke(IpcChannel.StorageGet, key) as Promise<T | undefined>,
    set: (key: string, value: unknown): Promise<void> =>
      ipcRenderer.invoke(IpcChannel.StorageSet, key, value) as Promise<void>,
  },
}

contextBridge.exposeInMainWorld('api', api)

export type EditorApi = typeof api
