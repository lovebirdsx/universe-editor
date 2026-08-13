/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Integration tests for the ExtensionHost connection over a real TCP socket: a
 *  daemon forks a fake host entry and pumps bytes TCP<->stdio. Covers the echo
 *  path, transparent reconnect (unacknowledged replay, no loss/dup), the in-band
 *  `{type:'exit'}` signal on child crash, and grace-expiry child reap.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  PersistentProtocol,
  REMOTE_PROTOCOL_VERSION,
  RemoteConnectionType,
  decodeControlJson,
  encodeControlJson,
  readFirstControlFrame,
  writeControlFrame,
  type IRemoteConnectionRequest,
} from '@universe-editor/platform'
import { connectNodeSocket } from '@universe-editor/node-services'
import { createDaemon, type RunningDaemon } from '../daemon.js'

const daemons: RunningDaemon[] = []
const tempRoots: string[] = []

// Reads stdin line-by-line, echoes `echo:<line>` to stdout, and exits 7 on
// "die". Deliberately does NOT exit on stdin EOF, so the daemon's graceful-stop
// backstop (SIGKILL) is what reaps it in the grace-expiry test.
const FAKE_HOST_SRC = `
import { writeFileSync } from 'node:fs'
import readline from 'node:readline'

const pidFile = process.env.FAKE_HOST_PID_FILE
if (pidFile) writeFileSync(pidFile, String(process.pid))

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  if (line === 'die') process.exit(7)
  process.stdout.write('echo:' + line + '\\n')
})
`

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'ue-exthost-'))
  tempRoots.push(root)
  return root
}

async function writeFakeHost(root: string): Promise<string> {
  const entry = path.join(root, 'fake-host.mjs')
  await writeFile(entry, FAKE_HOST_SRC)
  return entry
}

async function startDaemon(entry: string): Promise<RunningDaemon> {
  const daemon = await createDaemon({
    token: 'fixed-test-token',
    extensionHostEntry: entry,
    graceTimeMs: 400,
  })
  daemons.push(daemon)
  return daemon
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(predicate: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await sleep(10)
  }
}

interface ExtHostClient {
  readonly protocol: PersistentProtocol
  readonly reconnectionToken: string
  readonly messages: string[]
  readonly controls: Array<{ type: string; code?: number | null }>
  closed: boolean
  send(data: string): void
  reconnect(): Promise<void>
  destroySocket(): void
  dispose(): void
}

async function connect(daemon: RunningDaemon, pidFile: string): Promise<ExtHostClient> {
  const reconnectionToken = randomUUID()
  const socket = await connectNodeSocket(daemon.port)
  writeControlFrame(
    socket,
    encodeControlJson({
      type: 'connect',
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      token: daemon.token,
      connectionType: RemoteConnectionType.ExtensionHost,
      authority: 'test',
      reconnectionToken,
      isReconnection: false,
      args: { env: { FAKE_HOST_PID_FILE: pidFile } },
    } satisfies IRemoteConnectionRequest),
  )
  const { residual } = await readFirstControlFrame(socket, 10_000)
  const protocol = new PersistentProtocol({ socket, initialChunk: residual })

  const messages: string[] = []
  const controls: Array<{ type: string; code?: number | null }> = []
  let closed = false
  protocol.onMessage((d) => messages.push(new TextDecoder().decode(d)))
  protocol.onControlMessage((d) => controls.push(decodeControlJson(d)))
  protocol.onDidClose(() => {
    closed = true
  })

  return {
    protocol,
    reconnectionToken,
    messages,
    controls,
    get closed() {
      return closed
    },
    send: (data) => protocol.send(new TextEncoder().encode(data)),
    async reconnect() {
      const s = await connectNodeSocket(daemon.port)
      writeControlFrame(
        s,
        encodeControlJson({
          type: 'connect',
          protocolVersion: REMOTE_PROTOCOL_VERSION,
          token: daemon.token,
          connectionType: RemoteConnectionType.ExtensionHost,
          authority: 'test',
          reconnectionToken,
          isReconnection: true,
        } satisfies IRemoteConnectionRequest),
      )
      const { residual: r } = await readFirstControlFrame(s, 10_000)
      protocol.beginAcceptReconnection(s, r)
      protocol.endAcceptReconnection()
    },
    destroySocket() {
      protocol.getSocket().dispose()
    },
    dispose() {
      protocol.dispose()
    },
  }
}

afterEach(async () => {
  await Promise.all(daemons.splice(0).map((d) => d.dispose()))
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
  )
})

describe('ExtensionHostConnection', () => {
  it('handshakes, pumps bytes to the child and echoes them back', async () => {
    const root = await makeTempRoot()
    const daemon = await startDaemon(await writeFakeHost(root))
    const pidFile = path.join(root, 'host.pid')

    const client = await connect(daemon, pidFile)
    try {
      client.send('hello\n')
      await waitFor(() => client.messages.includes('echo:hello\n'))
      expect(client.messages).toEqual(['echo:hello\n'])
    } finally {
      client.dispose()
    }
  })

  it('replays bytes sent while the socket was down (no loss, no dup)', async () => {
    const root = await makeTempRoot()
    const daemon = await startDaemon(await writeFakeHost(root))
    const pidFile = path.join(root, 'host.pid')

    const client = await connect(daemon, pidFile)
    try {
      client.send('one\n')
      await waitFor(() => client.messages.includes('echo:one\n'))

      client.destroySocket()
      client.send('two\n')

      await client.reconnect()

      await waitFor(() => client.messages.includes('echo:two\n'))
      expect(client.messages.filter((m) => m === 'echo:two\n')).toHaveLength(1)
      expect(client.messages.filter((m) => m === 'echo:one\n')).toHaveLength(1)
    } finally {
      client.dispose()
    }
  })

  it('signals child exit in-band and closes the connection', async () => {
    const root = await makeTempRoot()
    const daemon = await startDaemon(await writeFakeHost(root))
    const pidFile = path.join(root, 'host.pid')

    const client = await connect(daemon, pidFile)
    try {
      client.send('die\n')
      await waitFor(() => client.controls.some((c) => c.type === 'exit' && c.code === 7))
      await waitFor(() => client.closed)
    } finally {
      client.dispose()
    }
  })

  it('reaps the child after grace expiry (socket dropped, no reconnect)', async () => {
    const root = await makeTempRoot()
    const daemon = await startDaemon(await writeFakeHost(root))
    const pidFile = path.join(root, 'host.pid')

    const client = await connect(daemon, pidFile)
    // The child writes its PID on startup.
    await waitFor(() => {
      try {
        return readFileSync(pidFile, 'utf8').trim().length > 0
      } catch {
        return false
      }
    })
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    expect(isAlive(pid)).toBe(true)

    client.destroySocket()

    // Grace (400ms) + graceful-stop SIGKILL backstop (2s) → child gone.
    await waitFor(() => !isAlive(pid), 6000)
    client.dispose()
  }, 15000)
})
