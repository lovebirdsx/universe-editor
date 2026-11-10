/*---------------------------------------------------------------------------------------------
 *  `--agent-sessions` CLI bridge.
 *
 *  A second instance cannot reach the first instance's renderers by itself, so it
 *  opens a local socket and advertises it through `requestSingleInstanceLock`'s
 *  additionalData. The primary queries every window's renderer and answers on that
 *  socket; the second instance prints the payload on stdout and exits without
 *  opening or focusing a window. With no running instance the caller prints an
 *  empty snapshot directly.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes } from 'node:crypto'
import { unlinkSync } from 'node:fs'
import { createServer, connect, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const AGENT_SESSIONS_PROTOCOL = 1

const PIPE_STEM = 'universe-editor-agent-sessions'
const WIN_PIPE_PREFIX = `\\\\.\\pipe\\${PIPE_STEM}-`
// A Unix socket file rather than a temp tree; `dispose` unlinks it.
const POSIX_PIPE_PREFIX = join(tmpdir(), `${PIPE_STEM}-`) // temp-root:allow
const RESPONSE_TIMEOUT_MS = 20_000
const CONNECT_TIMEOUT_MS = 5_000
const CONNECT_RETRY_MS = 50
const MAX_PIPE_NAME_LENGTH = 512

/** Answer shape shared by the CLI's stdout and the socket bridge. */
export interface AgentSessionsSnapshot {
  readonly windowCount: number
  /** Windows whose renderer did not answer in time; the result is incomplete. */
  readonly failedWindows: readonly number[]
  readonly sessions: readonly unknown[]
}

export function emptyAgentSessionsSnapshot(): AgentSessionsSnapshot {
  return { windowCount: 0, failedWindows: [], sessions: [] }
}

export function serializeAgentSessionsSnapshot(snapshot: AgentSessionsSnapshot): string {
  return `${JSON.stringify({ protocol: AGENT_SESSIONS_PROTOCOL, ...snapshot })}\n`
}

function createPipeName(): string {
  const suffix = `${process.pid}-${Date.now()}-${randomBytes(6).toString('hex')}`
  return process.platform === 'win32'
    ? `${WIN_PIPE_PREFIX}${suffix}`
    : `${POSIX_PIPE_PREFIX}${suffix}.sock`
}

export interface AgentSessionsResponseServer {
  readonly pipeName: string
  /** Resolves with the primary's JSON payload. */
  readonly response: Promise<string>
  dispose(): void
}

/**
 * Run by the second instance. Create the listener before requesting the
 * single-instance lock so it is ready when the primary handles the event.
 */
export function startAgentSessionsResponseServer(): AgentSessionsResponseServer {
  const pipeName = createPipeName()
  const socketPath = process.platform === 'win32' ? undefined : pipeName
  let server: Server | undefined
  let timer: NodeJS.Timeout | undefined
  let settled = false

  const response = new Promise<string>((resolve, reject) => {
    const settle = (fn: () => void) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      fn()
    }
    server = createServer((socket) => {
      const chunks: Buffer[] = []
      socket.on('data', (chunk) => chunks.push(chunk))
      socket.on('end', () => settle(() => resolve(Buffer.concat(chunks).toString('utf8'))))
      socket.on('error', (error) => settle(() => reject(error)))
    })
    server.once('error', (error) => settle(() => reject(error)))
    timer = setTimeout(
      () => settle(() => reject(new Error('等待主实例响应超时'))),
      RESPONSE_TIMEOUT_MS,
    )
    server.listen(pipeName)
  })

  return {
    pipeName,
    response,
    dispose() {
      server?.close()
      if (socketPath) {
        try {
          unlinkSync(socketPath)
        } catch {
          // Already gone.
        }
      }
    },
  }
}

/** Run by the primary: answer the second instance's query, retrying until it listens. */
export async function sendAgentSessionsPayload(
  pipeName: unknown,
  payload: string,
): Promise<boolean> {
  if (
    typeof pipeName !== 'string' ||
    pipeName.length === 0 ||
    pipeName.length > MAX_PIPE_NAME_LENGTH
  ) {
    return false
  }
  const deadline = Date.now() + CONNECT_TIMEOUT_MS
  while (Date.now() < deadline) {
    const socket = connect(pipeName)
    const connected = await new Promise<boolean>((resolve) => {
      socket.once('connect', () => resolve(true))
      socket.once('error', () => resolve(false))
    })
    if (!connected) {
      socket.destroy()
      await delay(CONNECT_RETRY_MS)
      continue
    }
    await new Promise<void>((resolve) => {
      socket.on('error', () => resolve())
      socket.end(payload, () => resolve())
    })
    socket.destroy()
    return true
  }
  return false
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
