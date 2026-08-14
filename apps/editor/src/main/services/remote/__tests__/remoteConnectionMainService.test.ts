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
import { findFreePort } from '../remoteDeploy.js'
import {
  RemoteConnectionMainService,
  type IRemoteConnectionStateChange,
  type RemoteSpawner,
} from '../remoteConnectionMainService.js'
import type { WslDeployer } from '../wslDeploy.js'

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

  async start(port = 0): Promise<void> {
    this.server = createServer((socket) => {
      void this._accept(socket)
    })
    await new Promise<void>((resolve) => this.server!.listen(port, '127.0.0.1', resolve))
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

interface FakeWsl {
  deployer: WslDeployer
  calls: string[]
}

function makeFakeWslDeployer(
  daemon: FakeDaemon,
  opts: { firstCheck?: 'not-deployed' | 'not-running' } = {},
): FakeWsl {
  const calls: string[] = []
  let firstCheckDone = false
  const info = (): unknown => ({
    serverVersion: '0.0.0',
    protocolVersion: REMOTE_PROTOCOL_VERSION,
    port: daemon.port,
    token: daemon.token,
    pid: 1,
  })
  const deployer = {
    serverVersion: '0.0.0',
    checkRemoteServer: async (distro: string) => {
      calls.push(`check:${distro}`)
      if (opts.firstCheck && !firstCheckDone) {
        firstCheckDone = true
        return opts.firstCheck === 'not-deployed'
          ? { state: 'not-deployed', reason: 'missing' }
          : { state: 'not-running' }
      }
      return { state: 'running', info: info() }
    },
    startRemoteDaemon: async (distro: string) => {
      calls.push(`start:${distro}`)
      return info()
    },
    stopRemoteDaemon: async (distro: string) => {
      calls.push(`stop:${distro}`)
    },
    deployRemoteServer: async (distro: string) => {
      calls.push(`deploy:${distro}`)
    },
  } as unknown as WslDeployer
  return { deployer, calls }
}

interface MadeWsl {
  svc: RemoteConnectionMainService
  calls: string[]
  states: IRemoteConnectionStateChange[]
}

function makeWslService(
  daemon: FakeDaemon,
  opts: { firstCheck?: 'not-deployed' | 'not-running' } = {},
): MadeWsl {
  const { deployer, calls } = makeFakeWslDeployer(daemon, opts)
  const states: IRemoteConnectionStateChange[] = []
  const svc = new RemoteConnectionMainService(
    { wslDeployer: deployer, getUserDataDir: () => '/tmp/ue-test' },
    undefined,
  )
  svc.onDidChangeState((s) => states.push(s))
  return { svc, calls, states }
}

describe('RemoteConnectionMainService wsl mode', () => {
  let made: MadeWsl | Made | undefined

  afterEach(() => {
    made?.svc.dispose()
    made = undefined
  })

  it('brings up via the wsl deployer without a forwarding phase', async () => {
    const daemon = await startDaemon()
    const wsl = (made = makeWslService(daemon))

    const conn = await wsl.svc.getConnection('wsl+Ubuntu')
    expect(conn.authority).toBe('wsl+Ubuntu')
    expect(wsl.states.map((s) => s.state)).toEqual(['deploying', 'handshaking', 'connected'])
    // The orchestrator receives the bare distro, not the authority.
    expect(wsl.calls).toEqual(['check:Ubuntu'])

    const pong = await conn.getChannel('test').call<string>('ping')
    expect(pong).toBe('pong')
  })

  it('waits out the WSL2 localhost relay: bring-up succeeds when the port opens late', async () => {
    // WSL2 materializes the Windows-side relay asynchronously after the daemon
    // starts listening in the distro — simulate it by reporting a port that only
    // begins to listen a beat after bring-up starts.
    const daemon = new FakeDaemon()
    daemons.push(daemon)
    daemon.port = await findFreePort()
    const wsl = (made = makeWslService(daemon))

    const pending = wsl.svc.getConnection('wsl+Ubuntu')
    setTimeout(() => void daemon.start(daemon.port), 300)
    const conn = await pending
    expect(conn.authority).toBe('wsl+Ubuntu')
    expect(wsl.states.map((s) => s.state)).toEqual(['deploying', 'handshaking', 'connected'])
  })

  it('deploys then starts when the check reports not-deployed', async () => {
    const daemon = await startDaemon()
    const wsl = (made = makeWslService(daemon, { firstCheck: 'not-deployed' }))

    await wsl.svc.getConnection('wsl+Ubuntu')
    expect(wsl.calls).toEqual(['check:Ubuntu', 'deploy:Ubuntu', 'start:Ubuntu'])
  })

  it('stopServer stops the daemon in the distro', async () => {
    const daemon = await startDaemon()
    const wsl = (made = makeWslService(daemon))

    await wsl.svc.getConnection('wsl+Ubuntu')
    await wsl.svc.stopServer('wsl+Ubuntu')
    expect(wsl.calls.at(-1)).toBe('stop:Ubuntu')
  })

  it('rejects malformed wsl authorities before any orchestration', async () => {
    const daemon = await startDaemon()
    const wsl = (made = makeWslService(daemon))

    await expect(wsl.svc.getConnection('wsl+bad name')).rejects.toThrow(/invalid WSL authority/)
    expect(wsl.calls).toEqual([])
  })

  it('remoteServerCmd (direct/e2e override) wins even for wsl+ authorities', async () => {
    const daemon = await startDaemon()
    const wsl = makeFakeWslDeployer(daemon)
    const procs: FakeProc[] = []
    const spawner: RemoteSpawner = () => {
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
        wslDeployer: wsl.deployer,
        getUserDataDir: () => '/tmp/ue-test',
      },
      undefined,
    )
    svc.onDidChangeState((s) => states.push(s))
    made = { svc, calls: wsl.calls, states }

    await svc.getConnection('wsl+Ubuntu')
    expect(states.map((s) => s.state)).toEqual(['deploying', 'handshaking', 'connected'])
    expect(procs).toHaveLength(1)
    expect(wsl.calls).toEqual([])
  })

  it('reconnects transparently by dialing the daemon port directly', async () => {
    const daemon = await startDaemon()
    const wsl = (made = makeWslService(daemon))

    const conn = await wsl.svc.getConnection('wsl+Ubuntu')
    wsl.svc.dropSocketForTesting('wsl+Ubuntu')
    expect(wsl.states.at(-1)?.state).toBe('reconnecting')

    const ping = conn.getChannel('test').call<string>('ping')
    await vi.waitFor(() => expect(wsl.states.at(-1)?.state).toBe('connected'), { timeout: 5000 })
    await expect(ping).resolves.toBe('pong')
  })
})
