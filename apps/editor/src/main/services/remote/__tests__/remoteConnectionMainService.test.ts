/*---------------------------------------------------------------------------------------------
 *  Tests for apps/editor/src/main/services/remote/remoteConnectionMainService.ts.
 *  Drives the TCP/PersistentProtocol connection state machine against a REAL
 *  in-process fake daemon (platform primitives + a raw net server) and a fake
 *  spawner (direct mode), so the handshake / getInfo / transparent-reconnect /
 *  give-up paths run end-to-end without ssh or a real server process.
 *--------------------------------------------------------------------------------------------*/

import { EventEmitter } from 'node:events'
import { createServer, type AddressInfo, type Server, type Socket as NetSocket } from 'node:net'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ChannelServer,
  PersistentProtocol,
  ProxyChannel,
  REMOTE_PROTOCOL_VERSION,
  RemoteChannels,
  RemoteConnectionErrorCode,
  binaryCodec,
  createChannelFromObject,
  decodeControlJson,
  encodeControlJson,
  readFirstControlFrame,
  writeControlFrame,
  type IRemoteConnectionRequest,
  type IRemoteConnectionResponse,
  type IRemoteEnvironment,
} from '@universe-editor/platform'
import { NodeSocket } from '@universe-editor/node-services'
import {
  RemoteConnectionMainService,
  type IRemoteConnectionStateChange,
  type RemoteSpawner,
} from '../remoteConnectionMainService.js'

const ENV: IRemoteEnvironment = {
  protocolVersion: REMOTE_PROTOCOL_VERSION,
  serverVersion: '0.0.0',
  os: 'linux',
  arch: 'x64',
  nodeVersion: '20.0.0',
  pathCaseSensitive: true,
  homeDir: '/home/u',
  tmpDir: '/tmp',
}

function daemonInfo(port: number, token: string): string {
  return `UNIVERSE_REMOTE_DAEMON_INFO=${JSON.stringify({
    serverVersion: '0.0.0',
    protocolVersion: REMOTE_PROTOCOL_VERSION,
    port,
    token,
    pid: 1234,
  })}\n`
}

class FakeDaemon {
  private server: Server | null = null
  private protocol: PersistentProtocol | null = null
  private channelServer: ChannelServer | null = null
  private acceptedToken: string | null = null
  private readonly sockets: NodeSocket[] = []

  port = 0
  readonly token = 'test-token'
  readonly env = ENV
  handshakeResponse: ((req: IRemoteConnectionRequest) => IRemoteConnectionResponse) | null = null
  /** Accept a reconnection handshake but never answer it (simulates a wedged peer). */
  hangReconnection = false
  acceptedCount = 0
  closedCount = 0

  async start(): Promise<void> {
    this.server = createServer((socket) => {
      void this._accept(socket)
    })
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve))
    this.port = (this.server!.address() as AddressInfo).port
  }

  private async _accept(raw: NetSocket): Promise<void> {
    const socket = new NodeSocket(raw)
    this.sockets.push(socket)
    this.acceptedCount++
    socket.onClose(() => {
      this.closedCount++
    })
    try {
      const { data, residual } = await readFirstControlFrame(socket, 10_000)
      const req = decodeControlJson<IRemoteConnectionRequest>(data)
      const response = this.handshakeResponse?.(req) ?? { type: 'ok' }
      if (this.hangReconnection && req.isReconnection) {
        // Keep the socket open and never write the response — the client's
        // readFirstControlFrame then blocks until its own timeout.
        return
      }
      writeControlFrame(socket, encodeControlJson(response))
      if (response.type !== 'ok') {
        return
      }
      if (req.isReconnection) {
        if (this.protocol && req.reconnectionToken === this.acceptedToken) {
          this.protocol.beginAcceptReconnection(socket, residual)
          this.protocol.endAcceptReconnection()
        }
        return
      }
      this.acceptedToken = req.reconnectionToken
      this.protocol = new PersistentProtocol({ socket, initialChunk: residual })
      this.channelServer = new ChannelServer(this.protocol, true, binaryCodec)
      this.channelServer.registerChannel(
        RemoteChannels.Handshake,
        ProxyChannel.fromService({ getInfo: async () => this.env }),
      )
      this.channelServer.registerChannel(
        'test',
        createChannelFromObject({ ping: async () => 'pong' }),
      )
    } catch {
      socket.dispose()
    }
  }

  async close(): Promise<void> {
    this.channelServer?.dispose()
    this.channelServer = null
    this.protocol?.dispose()
    this.protocol = null
    for (const s of this.sockets) s.dispose()
    this.sockets.length = 0
    const server = this.server
    this.server = null
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

class FakeStream extends EventEmitter {
  setEncoding = (): void => undefined
}

class FakeStdin extends EventEmitter {
  destroyed = false
  writable = true
  write(_data: string, _enc: string, cb: (err?: Error | null) => void): boolean {
    cb(null)
    return true
  }
  end(): void {
    // no-op
  }
}

class FakeProc extends EventEmitter {
  readonly stdout = new FakeStream()
  readonly stderr = new FakeStream()
  readonly stdin = new FakeStdin()
  pid = 1234
  killCalls = 0
  kill(): boolean {
    this.killCalls++
    return true
  }
  emitStdout(data: string): void {
    this.stdout.emit('data', Buffer.from(data, 'utf8'))
  }
}

interface Made {
  svc: RemoteConnectionMainService
  procs: FakeProc[]
  states: IRemoteConnectionStateChange[]
}

function makeDirectService(daemon: FakeDaemon): Made {
  const procs: FakeProc[] = []
  const spawner: RemoteSpawner = (_command, _args, _options) => {
    const proc = new FakeProc()
    procs.push(proc)
    queueMicrotask(() => proc.emitStdout(daemonInfo(daemon.port, daemon.token)))
    return proc as unknown as ChildProcessWithoutNullStreams
  }
  const states: IRemoteConnectionStateChange[] = []
  const svc = new RemoteConnectionMainService(
    {
      spawner,
      remoteServerCmd: JSON.stringify(['node', '/fake/bootstrap.js']),
      getUserDataDir: () => '/tmp/ue-test',
    },
    undefined,
  )
  svc.onDidChangeState((s) => states.push(s))
  return { svc, procs, states }
}

const daemons: FakeDaemon[] = []

async function startDaemon(): Promise<FakeDaemon> {
  const daemon = new FakeDaemon()
  await daemon.start()
  daemons.push(daemon)
  return daemon
}

afterEach(async () => {
  for (const d of daemons.splice(0)) {
    await d.close()
  }
})

describe('RemoteConnectionMainService direct mode', () => {
  let made: Made | undefined

  afterEach(() => {
    made?.svc.dispose()
    made = undefined
  })

  it('brings up over TCP, validates getInfo and serves a channel', async () => {
    const daemon = await startDaemon()
    made = makeDirectService(daemon)

    const conn = await made.svc.getConnection('host')
    expect(conn.authority).toBe('host')
    expect(conn.env.os).toBe('linux')
    expect(conn.env.pathCaseSensitive).toBe(true)
    expect(made.states.map((s) => s.state)).toEqual(['deploying', 'handshaking', 'connected'])

    const pong = await conn.getChannel('test').call<string>('ping')
    expect(pong).toBe('pong')
    await expect(made.svc.getConnection('host')).resolves.toBe(conn)
  })

  it('fails with a handshake error and can be retried', async () => {
    const daemon = await startDaemon()
    daemon.handshakeResponse = () => ({
      type: 'error',
      code: RemoteConnectionErrorCode.InvalidToken,
      message: 'bad token',
    })
    made = makeDirectService(daemon)

    await expect(made.svc.getConnection('host')).rejects.toThrow(/bad token/)
    expect(made.states.at(-1)?.state).toBe('failed')
    expect(made.states.at(-1)?.error).toContain('bad token')

    daemon.handshakeResponse = null
    made.svc.retryConnection('host')
    await vi.waitFor(() => expect(made!.states.at(-1)?.state).toBe('connected'))
    expect(made.states.some((s) => s.state === 'idle')).toBe(true)
  })

  it('reconnects transparently and replays a call made during the outage', async () => {
    const daemon = await startDaemon()
    made = makeDirectService(daemon)

    const conn = await made.svc.getConnection('host')
    expect(made.states.at(-1)?.state).toBe('connected')

    made.svc.dropSocketForTesting('host')
    expect(made.states.at(-1)?.state).toBe('reconnecting')

    const ping = conn.getChannel('test').call<string>('ping')

    await vi.waitFor(() => expect(made!.states.at(-1)?.state).toBe('connected'), {
      timeout: 5000,
    })
    await expect(ping).resolves.toBe('pong')
  })

  it('gives up on unknownReconnectionToken, fires onDidClose and moves to failed', async () => {
    const daemon = await startDaemon()
    made = makeDirectService(daemon)

    const conn = await made.svc.getConnection('host')
    let closed = false
    conn.onDidClose(() => {
      closed = true
    })

    daemon.handshakeResponse = (req) =>
      req.isReconnection
        ? {
            type: 'error',
            code: RemoteConnectionErrorCode.UnknownReconnectionToken,
            message: 'nope',
          }
        : { type: 'ok' }

    made.svc.dropSocketForTesting('host')
    await vi.waitFor(() => expect(made!.states.at(-1)?.state).toBe('failed'), { timeout: 5000 })
    expect(closed).toBe(true)
    expect(made.states.at(-1)?.error).toContain('nope')
  })

  it('destroying the service while a reconnect is hung closes the in-flight socket', async () => {
    const daemon = await startDaemon()
    made = makeDirectService(daemon)

    await made.svc.getConnection('host')
    expect(daemon.acceptedCount).toBe(1)

    // A wedged peer accepts the reconnection but never answers the handshake, so
    // the client's readFirstControlFrame blocks holding a live socket.
    daemon.hangReconnection = true
    made.svc.dropSocketForTesting('host')
    expect(made.states.at(-1)?.state).toBe('reconnecting')

    await vi.waitFor(() => expect(daemon.acceptedCount).toBe(2), { timeout: 5000 })

    made.svc.dispose()

    // Both the initial and the in-flight reconnect socket must be observed closed
    // by the daemon — before the fix, dispose() left the reconnect socket open and
    // its 10s handshake timer kept the process alive (blocking app quit).
    await vi.waitFor(() => expect(daemon.closedCount).toBe(2), { timeout: 5000 })
  })
})
