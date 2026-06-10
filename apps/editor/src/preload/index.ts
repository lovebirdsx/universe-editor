import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { IPC_PROTOCOL_CHANNEL } from '../shared/ipc/channelNames.js'
import { E2E_PROBE_ARGV_FLAG, E2E_PROBE_ENABLED_KEY } from '../shared/e2e/contract.js'

const HOME_DIR_FLAG = '--ue-home-dir='
const homeArg = process.argv.find((a) => a.startsWith(HOME_DIR_FLAG))
const home = homeArg ? homeArg.slice(HOME_DIR_FLAG.length) : ''

const bridge = {
  send(data: Uint8Array): void {
    ipcRenderer.send(IPC_PROTOCOL_CHANNEL, Buffer.from(data))
  },
  onMessage(cb: (data: Uint8Array) => void): () => void {
    const listener = (_event: IpcRendererEvent, payload: unknown): void => {
      if (payload instanceof Uint8Array) {
        cb(payload)
      } else if (payload && typeof payload === 'object' && 'buffer' in (payload as object)) {
        const buf = payload as Buffer
        cb(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength))
      }
    }
    ipcRenderer.on(IPC_PROTOCOL_CHANNEL, listener)
    return () => ipcRenderer.removeListener(IPC_PROTOCOL_CHANNEL, listener)
  },
  platform: process.platform as NodeJS.Platform,
  home,
  // Electron 33 removed `File.path`; the supported way to map a dragged-in
  // File back to an absolute filesystem path is webUtils.getPathForFile.
  getPathForFile(file: File): string {
    return webUtils.getPathForFile(file)
  },
}

contextBridge.exposeInMainWorld('ipc', bridge)

if (process.argv.includes(E2E_PROBE_ARGV_FLAG)) {
  contextBridge.exposeInMainWorld(E2E_PROBE_ENABLED_KEY, true)
}

export type IpcBridge = typeof bridge
