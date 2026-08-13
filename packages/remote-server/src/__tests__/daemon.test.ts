/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Integration tests for the daemon over a real TCP socket: handshake validation,
 *  URI round-trip through the per-connection transformer, and reconnect
 *  transparency (PersistentProtocol replay keeps subscriptions and in-flight
 *  calls alive across a socket swap).
 *--------------------------------------------------------------------------------------------*/

import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ChannelClient,
  PersistentProtocol,
  ProxyChannel,
  REMOTE_PROTOCOL_VERSION,
  RemoteChannels,
  RemoteConnectionErrorCode,
  RemoteConnectionType,
  URI,
  createBinaryCodec,
  decodeControlJson,
  encodeControlJson,
  readFirstControlFrame,
  writeControlFrame,
  type IFileService,
  type IRemoteConnectionRequest,
  type IRemoteConnectionResponse,
  type IRemoteFileStreamEvent,
  type IRemoteFileStreamService,
  type IRemoteHandshakeService,
  type IRemoteWatcherTunnel,
  type WatcherHostResponse,
} from '@universe-editor/platform'
import { connectNodeSocket } from '@universe-editor/node-services'
import { createDaemon, type RunningDaemon } from '../daemon.js'

const daemons: RunningDaemon[] = []
const tempRoots: string[] = []

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'ue-daemon-'))
  tempRoots.push(root)
  return root
}

async function startDaemon(): Promise<RunningDaemon> {
  const daemon = await createDaemon({ token: 'fixed-test-token' })
  daemons.push(daemon)
  return daemon
}

afterEach(async () => {
  await Promise.all(daemons.splice(0).map((d) => d.dispose()))
  await Promise.all(
    tempRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })),
  )
})

interface ClientConnection {
  readonly reconnectionToken: string
  readonly authority: string
  getService: <T extends object>(name: string) => T
  reconnect(): Promise<void>
  destroySocket(): void
  dispose(): void
}

async function connect(
  daemon: RunningDaemon,
  opts: { reconnectionToken?: string; authority?: string } = {},
): Promise<ClientConnection> {
  const reconnectionToken = opts.reconnectionToken ?? randomUUID()
  const authority = opts.authority ?? 'test'

  const socket = await connectNodeSocket(daemon.port)
  writeControlFrame(
    socket,
    encodeControlJson({
      type: 'connect',
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      token: daemon.token,
      connectionType: RemoteConnectionType.Management,
      authority,
      reconnectionToken,
      isReconnection: false,
    } satisfies IRemoteConnectionRequest),
  )
  const { residual } = await readFirstControlFrame(socket, 10_000)

  const protocol = new PersistentProtocol({ socket, initialChunk: residual })
  const client = new ChannelClient(protocol, true, createBinaryCodec())

  return {
    reconnectionToken,
    authority,
    getService: <T extends object>(name: string) =>
      ProxyChannel.toService<T>(client.getChannel(name)),
    async reconnect(): Promise<void> {
      const newSocket = await connectNodeSocket(daemon.port)
      writeControlFrame(
        newSocket,
        encodeControlJson({
          type: 'connect',
          protocolVersion: REMOTE_PROTOCOL_VERSION,
          token: daemon.token,
          connectionType: RemoteConnectionType.Management,
          authority,
          reconnectionToken,
          isReconnection: true,
        } satisfies IRemoteConnectionRequest),
      )
      const { residual: reconnectResidual } = await readFirstControlFrame(newSocket, 10_000)
      protocol.beginAcceptReconnection(newSocket, reconnectResidual)
      protocol.endAcceptReconnection()
    },
    destroySocket(): void {
      protocol.getSocket().dispose()
    },
    dispose(): void {
      client.dispose()
      protocol.dispose()
    },
  }
}

async function handshakeError(
  daemon: RunningDaemon,
  overrides: Partial<IRemoteConnectionRequest>,
): Promise<IRemoteConnectionResponse> {
  const socket = await connectNodeSocket(daemon.port)
  try {
    writeControlFrame(
      socket,
      encodeControlJson({
        type: 'connect',
        protocolVersion: REMOTE_PROTOCOL_VERSION,
        token: daemon.token,
        connectionType: RemoteConnectionType.Management,
        authority: 'test',
        reconnectionToken: randomUUID(),
        isReconnection: false,
        ...overrides,
      } satisfies IRemoteConnectionRequest),
    )
    const { data } = await readFirstControlFrame(socket, 10_000)
    return decodeControlJson<IRemoteConnectionResponse>(data)
  } finally {
    socket.dispose()
  }
}

function remoteUriFor(fsPath: string): URI {
  return URI.from({ scheme: 'remote-ssh', authority: 'test', path: URI.file(fsPath).path })
}

function makeBytes(n: number): Uint8Array {
  const b = new Uint8Array(n)
  for (let i = 0; i < n; i++) b[i] = (i * 31 + 7) & 0xff
  return b
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

function streamError(e: { message: string; code?: string }): Error {
  const err = new Error(e.message) as Error & { code?: string }
  if (e.code !== undefined) err.code = e.code
  return err
}

async function readStreamed(svc: IRemoteFileStreamService, resource: URI): Promise<Uint8Array> {
  const { streamId, size } = await svc.startReadStream(resource)
  const chunks: Uint8Array[] = []
  let received = 0
  await new Promise<void>((resolve, reject) => {
    const sub = svc.onReadStreamData((e: IRemoteFileStreamEvent) => {
      if (e.streamId !== streamId) return
      if (e.error) {
        sub.dispose()
        reject(streamError(e.error))
        return
      }
      if (e.done) {
        sub.dispose()
        if (received !== size) reject(new Error(`early end ${received}/${size}`))
        else resolve()
        return
      }
      if (e.data !== undefined) {
        chunks.push(e.data)
        received += e.data.length
        void svc.ackReadStream(streamId, e.seq)
      }
    })
  })
  const out = new Uint8Array(size)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}

describe('createDaemon', () => {
  it('fresh handshake returns a valid IRemoteEnvironment', async () => {
    const daemon = await startDaemon()
    const conn = await connect(daemon)
    try {
      const handshake = conn.getService<IRemoteHandshakeService>(RemoteChannels.Handshake)
      const info = await handshake.getInfo()
      expect(info.protocolVersion).toBe(REMOTE_PROTOCOL_VERSION)
      expect(info.os).toBe(process.platform)
      expect(info.arch).toBe(process.arch)
      expect(info.nodeVersion).toBe(process.versions.node)
      expect(info.homeDir).toBeTruthy()
      expect(info.tmpDir).toBeTruthy()
      expect(typeof info.pathCaseSensitive).toBe('boolean')
    } finally {
      conn.dispose()
    }
  })

  it('round-trips file ops with remote-ssh URIs (transformer lives on the server)', async () => {
    const daemon = await startDaemon()
    const root = await makeTempRoot()
    const filePath = path.join(root, 'a.txt')
    await writeFile(filePath, 'hello remote')

    const conn = await connect(daemon)
    try {
      const fs = conn.getService<IFileService>(RemoteChannels.FileSystem)
      const remoteFile = remoteUriFor(filePath)

      const stat = await fs.stat(remoteFile)
      expect(stat.isFile).toBe(true)
      expect(stat.resource.scheme).toBe('remote-ssh')
      expect(stat.resource.authority).toBe('test')

      const bytes = await fs.readFile(remoteFile)
      expect(new TextDecoder().decode(bytes)).toBe('hello remote')

      const list = await fs.list(remoteUriFor(root))
      expect(list.map((e) => e.name).sort()).toEqual(['a.txt'])
    } finally {
      conn.dispose()
    }
  })

  it('streams a large file byte-for-byte over the FileSystem channel', async () => {
    const daemon = await startDaemon()
    const root = await makeTempRoot()
    const filePath = path.join(root, 'big.bin')
    const expected = makeBytes(5 * 1024 * 1024)
    await writeFile(filePath, expected)

    const conn = await connect(daemon)
    try {
      const svc = conn.getService<IRemoteFileStreamService>(RemoteChannels.FileSystem)
      const bytes = await readStreamed(svc, remoteUriFor(filePath))
      expect(bytes.length).toBe(expected.length)
      expect(bytes).toEqual(expected)
    } finally {
      conn.dispose()
    }
  }, 20000)

  it('serves other calls while a large stream is paused awaiting acks', async () => {
    const daemon = await startDaemon()
    const root = await makeTempRoot()
    const filePath = path.join(root, 'big.bin')
    await writeFile(filePath, makeBytes(5 * 1024 * 1024))
    const smallPath = path.join(root, 'small.txt')
    await writeFile(smallPath, 'small payload')

    const conn = await connect(daemon)
    try {
      const svc = conn.getService<IRemoteFileStreamService>(RemoteChannels.FileSystem)
      const { streamId } = await svc.startReadStream(remoteUriFor(filePath))

      let chunkCount = 0
      let done = false
      const sub = svc.onReadStreamData((e) => {
        if (e.streamId !== streamId) return
        if (e.done) done = true
        else if (e.data !== undefined) chunkCount++
        // Deliberately no ack: the server must pause after its 16-chunk window.
      })

      await waitFor(() => chunkCount >= 16)
      expect(done).toBe(false)

      // Other channel calls must complete while the stream is paused.
      const stat = await svc.stat(remoteUriFor(root))
      expect(stat.isDirectory).toBe(true)
      expect(await svc.readFileText(remoteUriFor(smallPath))).toBe('small payload')
      expect(done).toBe(false)

      sub.dispose()
      await svc.cancelReadStream(streamId)
    } finally {
      conn.dispose()
    }
  }, 20000)

  it('cancel stops a chunk stream', async () => {
    const daemon = await startDaemon()
    const root = await makeTempRoot()
    const filePath = path.join(root, 'big.bin')
    await writeFile(filePath, makeBytes(5 * 1024 * 1024))

    const conn = await connect(daemon)
    try {
      const svc = conn.getService<IRemoteFileStreamService>(RemoteChannels.FileSystem)
      const { streamId } = await svc.startReadStream(remoteUriFor(filePath))

      let chunkCount = 0
      let done = false
      const sub = svc.onReadStreamData((e) => {
        if (e.streamId !== streamId) return
        if (e.done) done = true
        else if (e.data !== undefined) chunkCount++
        // No ack: the server pauses after 16 chunks and waits forever.
      })

      await waitFor(() => chunkCount >= 16)
      expect(done).toBe(false)

      await svc.cancelReadStream(streamId)
      const snapshot = chunkCount
      await sleep(300)
      expect(chunkCount).toBe(snapshot)
      expect(done).toBe(false)

      sub.dispose()
    } finally {
      conn.dispose()
    }
  }, 20000)

  it('rejects a wrong token with invalidToken', async () => {
    const daemon = await startDaemon()
    const resp = await handshakeError(daemon, { token: 'wrong-token' })
    expect(resp).toEqual({
      type: 'error',
      code: RemoteConnectionErrorCode.InvalidToken,
      message: expect.any(String),
    })
  })

  it('rejects a wrong protocol version with versionMismatch', async () => {
    const daemon = await startDaemon()
    const resp = await handshakeError(daemon, { protocolVersion: REMOTE_PROTOCOL_VERSION + 1 })
    expect(resp).toEqual({
      type: 'error',
      code: RemoteConnectionErrorCode.VersionMismatch,
      message: expect.any(String),
    })
  })

  it('rejects an unknown reconnection token', async () => {
    const daemon = await startDaemon()
    const resp = await handshakeError(daemon, { isReconnection: true })
    expect(resp).toEqual({
      type: 'error',
      code: RemoteConnectionErrorCode.UnknownReconnectionToken,
      message: expect.any(String),
    })
  })

  it('keeps watcher event subscriptions and in-flight calls alive across a reconnect', async () => {
    const daemon = await startDaemon()
    const root = await makeTempRoot()
    const existingFile = path.join(root, 'a.txt')
    await writeFile(existingFile, 'pre-existing')

    const conn = await connect(daemon)
    try {
      const tunnel = conn.getService<IRemoteWatcherTunnel>(RemoteChannels.FileWatcher)
      const responses: WatcherHostResponse[] = []
      const sub = tunnel.onMessage((msg) => responses.push(msg))

      await tunnel.post({ kind: 'subscribe', seq: 0, id: 7, dir: root, ignore: [] })
      expect(responses.some((r) => r.kind === 'ack' && r.seq === 0)).toBe(true)

      // Drop the socket, then reconnect with the same reconnection token. The
      // channel event subscription must survive transparently.
      conn.destroySocket()

      // An in-flight call issued while the socket is down must resolve after
      // the reconnect (PersistentProtocol re-drives its unacknowledged queue).
      const fs = conn.getService<IFileService>(RemoteChannels.FileSystem)
      const statPromise = fs.stat(remoteUriFor(existingFile))

      await conn.reconnect()

      const stat = await statPromise
      expect(stat.isFile).toBe(true)
      expect(stat.resource.scheme).toBe('remote-ssh')

      await writeFile(path.join(root, 'b.txt'), 'x')
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('no watcher events after reconnect')), 8000)
        const poll = (): void => {
          if (responses.some((r) => r.kind === 'events' && r.id === 7)) {
            clearTimeout(timer)
            resolve()
          } else {
            setTimeout(poll, 20)
          }
        }
        poll()
      })

      sub.dispose()
    } finally {
      conn.dispose()
    }
  }, 20000)
})
