import type { PingResult } from '../shared/ipc-channels.js'

export interface EditorApi {
  ping: (rendererSentAt: number) => Promise<PingResult>
}

declare global {
  interface Window {
    api: EditorApi
  }
}

export {}
