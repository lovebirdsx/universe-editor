import type { IpcBridge } from '../preload/index.js'

declare global {
  interface Window {
    ipc: IpcBridge
  }
}

export {}
