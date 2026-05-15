import type { PingResult } from '../shared/ipc-channels.js'

export interface StorageApi {
  get: <T = unknown>(key: string) => Promise<T | undefined>
  set: (key: string, value: unknown) => Promise<void>
}

export interface EditorApi {
  ping: (rendererSentAt: number) => Promise<PingResult>
  storage: StorageApi
}

declare global {
  interface Window {
    api: EditorApi
  }
}

export {}
