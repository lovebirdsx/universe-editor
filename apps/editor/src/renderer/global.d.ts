import type { PingResult } from '../shared/ipc-channels.js'

export interface StorageApi {
  get: <T = unknown>(key: string) => Promise<T | undefined>
  set: (key: string, value: unknown) => Promise<void>
}

export interface EditorApi {
  ping: (rendererSentAt: number) => Promise<PingResult>
  storage: StorageApi
  platform: string
  windowMinimize: () => Promise<void>
  windowMaximize: () => Promise<void>
  windowClose: () => Promise<void>
  windowIsMaximized: () => Promise<boolean>
  onWindowMaximizeChange: (callback: (isMaximized: boolean) => void) => () => void
}

declare global {
  interface Window {
    api: EditorApi
  }
}

export {}
