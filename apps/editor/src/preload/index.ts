import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
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

  platform: process.platform,

  windowMinimize: (): Promise<void> => ipcRenderer.invoke(IpcChannel.WindowMinimize),
  windowMaximize: (): Promise<void> => ipcRenderer.invoke(IpcChannel.WindowMaximize),
  windowClose: (): Promise<void> => ipcRenderer.invoke(IpcChannel.WindowClose),
  windowIsMaximized: (): Promise<boolean> => ipcRenderer.invoke(IpcChannel.WindowIsMaximized),

  onWindowMaximizeChange: (callback: (isMaximized: boolean) => void): (() => void) => {
    const listener = (_: IpcRendererEvent, val: boolean) => callback(val)
    ipcRenderer.on(IpcChannel.WindowMaximizeChange, listener)
    return () => ipcRenderer.removeListener(IpcChannel.WindowMaximizeChange, listener)
  },
}

contextBridge.exposeInMainWorld('api', api)

export type EditorApi = typeof api
