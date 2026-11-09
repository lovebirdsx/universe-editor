import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type { IOpenWindowNewAgentSession } from '@universe-editor/platform'
import { IPC_PROTOCOL_CHANNEL } from '../shared/ipc/channelNames.js'
import { E2E_PROBE_ARGV_FLAG, E2E_PROBE_ENABLED_KEY } from '../shared/e2e/contract.js'
import {
  EXTENSION_DEVELOPMENT_ARGV_FLAG,
  EXTENSION_DEVELOPMENT_ENABLED_KEY,
} from '../shared/extensionDevelopment.js'
import { parseConfigurationDefaultsArg } from '../shared/productDefaults.js'

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

const NEW_AGENT_SESSION_FLAG = '--ue-new-agent-session='
const newAgentSessionArg = process.argv.find((a) => a.startsWith(NEW_AGENT_SESSION_FLAG))
const newAgentSession = parseNewAgentSessionArg(
  newAgentSessionArg ? newAgentSessionArg.slice(NEW_AGENT_SESSION_FLAG.length) : undefined,
)

const REMOTE_AUTHORITY_FLAG = '--ue-remote-authority='
const remoteAuthorityArg = process.argv.find((a) => a.startsWith(REMOTE_AUTHORITY_FLAG))
const remoteAuthority = remoteAuthorityArg
  ? remoteAuthorityArg.slice(REMOTE_AUTHORITY_FLAG.length)
  : undefined

const configurationDefaults = parseConfigurationDefaultsArg(process.argv)

/** Validate the `--ue-new-agent-session` payload / an IPC push; malformed input is ignored. */
function normalizeNewAgentSession(raw: unknown): IOpenWindowNewAgentSession | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  const agentId = o['agentId']
  const cwd = o['cwd']
  if (typeof agentId !== 'string' || typeof cwd !== 'string') return undefined
  const authority = typeof o['authority'] === 'string' ? o['authority'] : undefined
  return { agentId, cwd, ...(authority !== undefined ? { authority } : {}) }
}

function parseNewAgentSessionArg(
  encoded: string | undefined,
): IOpenWindowNewAgentSession | undefined {
  if (encoded === undefined) return undefined
  try {
    return normalizeNewAgentSession(JSON.parse(decodeURIComponent(encoded)))
  } catch {
    return undefined
  }
}

/** 存储在监听器没有就绪时收到的 deep link，等待监听器添加后进行处理 */
const pendingOpenUriTargets: string[] = []

type OpenUriListener = (target: string) => void
const openUriListeners = new Set<OpenUriListener>()

/** 监听主进程发送的 deep link，传递给已注册的监听器，如果没有监听器则存储在 pendingOpenUriTargets 中 */
ipcRenderer.on('ue:open-uri', (_event: IpcRendererEvent, target: unknown) => {
  if (typeof target !== 'string') return
  if (openUriListeners.size === 0) {
    pendingOpenUriTargets.push(target)
    return
  }
  for (const listener of openUriListeners) listener(target)
})

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
  /** remote-ssh authority this window is scoped to at cold-launch (undefined for a local window). */
  remoteAuthority,
  /**
   * Build-time defaults for settings.json keys (empty when none were injected).
   * Synchronous by design: the renderer registers these before constructing
   * ConfigurationService, so no consumer can observe a pre-override value.
   */
  configurationDefaults,
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
  /** A brand-new agent session this window should create at cold-launch; undefined if none. */
  newAgentSession,
  /** Listen for a new-session request pushed by the main process to an already-open window. */
  onNewAgentSession(cb: (request: IOpenWindowNewAgentSession) => void): () => void {
    const listener = (_event: IpcRendererEvent, request: unknown): void => {
      const parsed = normalizeNewAgentSession(request)
      if (parsed) cb(parsed)
    }
    ipcRenderer.on('ue:new-agent-session', listener)
    return () => ipcRenderer.removeListener('ue:new-agent-session', listener)
  },
  /** Opener target (`path:line:col` or `command:…`) from a deep link that cold-launched this window. */
  openUriTarget,
  /** Listen for a deep-link opener target pushed by the main process to a live window. */
  onOpenUri(cb: (target: string) => void): () => void {
    openUriListeners.add(cb)

    // 处理在监听器注册之前收到的 deep link
    while (pendingOpenUriTargets.length > 0) {
      cb(pendingOpenUriTargets.shift()!)
    }

    return () => {
      openUriListeners.delete(cb)
    }
  },
}

contextBridge.exposeInMainWorld('ipc', bridge)

if (process.argv.includes(E2E_PROBE_ARGV_FLAG)) {
  contextBridge.exposeInMainWorld(E2E_PROBE_ENABLED_KEY, true)
}

if (process.argv.includes(EXTENSION_DEVELOPMENT_ARGV_FLAG)) {
  contextBridge.exposeInMainWorld(EXTENSION_DEVELOPMENT_ENABLED_KEY, true)
}

export type IpcBridge = typeof bridge
