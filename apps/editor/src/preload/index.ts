import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { IPC_PROTOCOL_CHANNEL } from '../shared/ipc/channelNames.js'
import { E2E_PROBE_ARGV_FLAG, E2E_PROBE_ENABLED_KEY } from '../shared/e2e/contract.js'

const HOME_DIR_FLAG = '--ue-home-dir='
const homeArg = process.argv.find((a) => a.startsWith(HOME_DIR_FLAG))
const home = homeArg ? homeArg.slice(HOME_DIR_FLAG.length) : ''

const OPEN_FILE_FLAG = '--ue-open-file='
const openFileArg = process.argv.find((a) => a.startsWith(OPEN_FILE_FLAG))
const openFilePath = openFileArg ? openFileArg.slice(OPEN_FILE_FLAG.length) : undefined

const OPEN_SESSION_FLAG = '--ue-open-session='
const openSessionArg = process.argv.find((a) => a.startsWith(OPEN_SESSION_FLAG))
const openSessionId = openSessionArg ? openSessionArg.slice(OPEN_SESSION_FLAG.length) : undefined

const OPEN_URI_FLAG = '--ue-open-uri='
const openUriArg = process.argv.find((a) => a.startsWith(OPEN_URI_FLAG))
const openUriTarget = openUriArg ? openUriArg.slice(OPEN_URI_FLAG.length) : undefined

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
  /** Absolute path of the file passed via CLI argv at cold-launch (undefined if none). */
  openFilePath,
  /** Listen for files pushed by the main process (second-instance scenario). */
  onOpenFile(cb: (path: string) => void): () => void {
    const listener = (_event: IpcRendererEvent, path: unknown): void => {
      if (typeof path === 'string') cb(path)
    }
    ipcRenderer.on('ue:open-file', listener)
    return () => ipcRenderer.removeListener('ue:open-file', listener)
  },
  /** ACP session id this window should resume at cold-launch (cross-worktree follow); undefined if none. */
  openSessionId,
  /** Listen for a session id pushed by the main process when an already-open window is focused. */
  onOpenSession(cb: (sessionId: string) => void): () => void {
    const listener = (_event: IpcRendererEvent, sessionId: unknown): void => {
      if (typeof sessionId === 'string') cb(sessionId)
    }
    ipcRenderer.on('ue:open-session', listener)
    return () => ipcRenderer.removeListener('ue:open-session', listener)
  },
  /** Opener target (`path:line:col` or `command:…`) from a deep link that cold-launched this window. */
  openUriTarget,
  /** Listen for a deep-link opener target pushed by the main process to a live window. */
  onOpenUri(cb: (target: string) => void): () => void {
    const listener = (_event: IpcRendererEvent, target: unknown): void => {
      if (typeof target === 'string') cb(target)
    }
    ipcRenderer.on('ue:open-uri', listener)
    return () => ipcRenderer.removeListener('ue:open-uri', listener)
  },
}

contextBridge.exposeInMainWorld('ipc', bridge)

if (process.argv.includes(E2E_PROBE_ARGV_FLAG)) {
  contextBridge.exposeInMainWorld(E2E_PROBE_ENABLED_KEY, true)
}

export type IpcBridge = typeof bridge
