/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Main-side owner of remote server connections. Brings up (and keeps alive) one
 *  logical Management connection per remote-ssh authority: ensure the remote
 *  daemon is deployed/running (ssh orchestration) or spawn it directly (dev/e2e),
 *  open an ssh -L forward to its TCP port, handshake over a PersistentProtocol,
 *  and hand out channels via a ChannelClient.
 *
 *  Reconnects are transparent to the channel layer: on a socket drop the protocol
 *  re-attaches to a fresh socket and replays the unacknowledged queue, so the fs /
 *  search / watcher services never see a close. A permanent rejection
 *  (unknownReconnectionToken / invalidToken after a daemon restart) gives up,
 *  fires the connection's onDidClose (driving the existing service-level rebuild
 *  paths) and moves to `failed`; the next getConnection starts a fresh bring-up.
 *--------------------------------------------------------------------------------------------*/

import { StringDecoder } from 'node:string_decoder'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  ChannelClient,
  createDecorator,
  createNamedLogger,
  Disposable,
  DisposableStore,
  Emitter,
  PersistentProtocol,
  ProtocolConstants,
  ProxyChannel,
  REMOTE_PROTOCOL_VERSION,
  RemoteChannels,
  RemoteConnectionErrorCode,
  RemoteConnectionType,
  binaryCodec,
  type Event,
  type IChannel,
  type IDisposable,
  type ILogger,
  type ISocket,
  ILoggerService,
  type IRemoteDaemonInfo,
  type IRemoteEnvironment,
  type IRemoteHandshakeService,
  type IRemoteConnectionRequest,
  type IRemoteExtensionHostStartArgs,
} from '@universe-editor/platform'
import {
  ManagedChildProcess,
  connectNodeSocket,
  type ManagedExit,
} from '@universe-editor/node-services'
import { buildChildEnv } from '../process/env.js'
import { decodeDiagnostic } from '../process/decode.js'
import {
  RemoteDeployer,
  defaultRemoteSpawner,
  parseDaemonInfoLine,
  validateAuthority,
  type RemoteSpawner,
} from './remoteDeploy.js'
import { performClientHandshake, type RemoteHandshakeError } from './remoteHandshake.js'
import {
  RemoteExtensionHostTunnel,
  type IRemoteExtensionHostTunnel,
} from './remoteExtensionHostTunnel.js'

export interface IRemoteConnection {
  readonly authority: string
  readonly env: IRemoteEnvironment
  getChannel(name: string): IChannel
  readonly onDidClose: Event<void>
}

export type RemoteConnectionState =
  | 'idle'
  | 'deploying'
  | 'forwarding'
  | 'handshaking'
  | 'connected'
  | 'reconnecting'
  | 'failed'
  | 'disposed'

export interface IRemoteConnectionStateChange {
  readonly authority: string
  readonly state: RemoteConnectionState
  readonly error?: string
}

export interface IRemoteConnectionService {
  readonly _serviceBrand: undefined
  getConnection(authority: string): Promise<IRemoteConnection>
  openExtensionHostConnection(
    authority: string,
    args?: IRemoteExtensionHostStartArgs,
  ): Promise<IRemoteExtensionHostTunnel>
  readonly onDidChangeState: Event<IRemoteConnectionStateChange>
  retryConnection(authority: string): void
  stopServer(authority: string): Promise<void>
  closeConnection(authority: string): Promise<void>
  dropSocketForTesting(authority: string): void
  dropExtensionHostSocketForTesting(authority: string): void
  dispose(): void
}

export const IRemoteConnectionService =
  createDecorator<IRemoteConnectionService>('remoteConnectionService')

/** Spawner abstraction — injectable for tests so we don't launch real processes. */
export type { RemoteSpawner }

const HANDSHAKE_TIMEOUT_MS = 10_000
const DIRECT_INFO_TIMEOUT_MS = 10_000
const RECONNECT_BACKOFF_MS = [250, 500, 1000, 2000, 2000] as const

const PERMANENT_RECONNECT_CODES: ReadonlySet<string> = new Set([
  RemoteConnectionErrorCode.InvalidToken,
  RemoteConnectionErrorCode.VersionMismatch,
  RemoteConnectionErrorCode.UnknownReconnectionToken,
  RemoteConnectionErrorCode.DuplicateReconnectionToken,
])

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
    // Backstop only: never the last ref'd handle keeping the process alive on quit.
    timer.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

function sanitizeAuthority(authority: string): string {
  return authority.replace(/[^A-Za-z0-9._-]/g, '_')
}

class RemoteConnection extends Disposable implements IRemoteConnection {
  private readonly _onDidClose = this._register(new Emitter<void>())
  readonly onDidClose: Event<void> = this._onDidClose.event
  private readonly _client: ChannelClient

  constructor(
    readonly authority: string,
    readonly env: IRemoteEnvironment,
    client: ChannelClient,
  ) {
    super()
    this._client = client
    this._register(client)
  }

  getChannel(name: string): IChannel {
    return this._client.getChannel(name)
  }

  fireClose(): void {
    this._onDidClose.fire()
  }
}

interface ConnectionForward {
  readonly localPort: number
  readonly process: ManagedChildProcess
  readonly exitSub: { dispose(): void }
  readonly stderrSub: { dispose(): void }
}

interface ConnectionEntry {
  authority: string
  state: RemoteConnectionState
  connection: RemoteConnection | null
  protocol: PersistentProtocol | null
  /** Current socket held by `protocol`. PersistentProtocol does NOT own socket
   *  disposal (server-side ManagementConnection disposes it explicitly) — we do. */
  socket: ISocket | null
  /** Subscriptions on `protocol` (socket close/timeout) — disposed with it. */
  protocolSubs: DisposableStore | null
  env: IRemoteEnvironment | null
  promise: Promise<IRemoteConnection> | null
  forward: ConnectionForward | null
  directProcess: ManagedChildProcess | null
  /** Subscriptions on `directProcess` (stderr/exit) — disposed with it. */
  directSubs: DisposableStore | null
  daemonPort: number
  daemonToken: string
  reconnectionToken: string
  isDirect: boolean
  reconnectTimer: NodeJS.Timeout | null
  reconnectSocket: ISocket | null
  reconnectAttempt: number
  reconnectionStart: number
  closedByUser: boolean
}

export interface RemoteConnectionMainServiceOptions {
  readonly spawner?: RemoteSpawner
  readonly remoteServerCmd?: string
  readonly deployer?: RemoteDeployer
  readonly getUserDataDir?: () => string
}

export class RemoteConnectionMainService extends Disposable implements IRemoteConnectionService {
  declare readonly _serviceBrand: undefined

  private readonly _logger: ILogger
  private readonly _spawn: RemoteSpawner
  private readonly _remoteServerCmd: string | undefined
  private readonly _deployer: RemoteDeployer
  private readonly _getUserDataDir: () => string
  private readonly _entries = new Map<string, ConnectionEntry>()
  private readonly _onDidChangeState = this._register(new Emitter<IRemoteConnectionStateChange>())
  readonly onDidChangeState: Event<IRemoteConnectionStateChange> = this._onDidChangeState.event
  private readonly _extensionHostTunnels = new Map<RemoteExtensionHostTunnel, IDisposable>()
  private _disposed = false

  constructor(
    options: RemoteConnectionMainServiceOptions = {},
    @ILoggerService loggerService?: ILoggerService,
  ) {
    super()
    this._logger = createNamedLogger(loggerService, {
      id: 'remoteConnection',
      name: 'Remote Connection',
    })
    this._spawn = options.spawner ?? defaultRemoteSpawner
    this._remoteServerCmd = options.remoteServerCmd
    this._deployer =
      options.deployer ?? new RemoteDeployer({ logger: this._logger, spawner: this._spawn })
    this._getUserDataDir = options.getUserDataDir ?? (() => '')
  }

  // ------------------------- public surface -------------------------

  getConnection(authority: string): Promise<IRemoteConnection> {
    validateAuthority(authority)
    const entry = this._entry(authority)
    if (entry.state === 'disposed') {
      return Promise.reject(new Error('remote connection service is disposed'))
    }
    if (entry.connection) return Promise.resolve(entry.connection)
    if (entry.promise) return entry.promise
    if (entry.state === 'failed') {
      // A subsequent getConnection after a permanent failure starts fresh.
      this._fireState(entry, 'idle')
    }
    return this._startBringUp(entry)
  }

  retryConnection(authority: string): void {
    try {
      const entry = this._entries.get(authority)
      if (!entry) {
        void this.getConnection(authority).catch(() => undefined)
        return
      }
      this._teardownForRetry(entry)
      this._fireState(entry, 'idle')
      void this.getConnection(authority).catch(() => undefined)
    } catch {
      // invalid authority or disposed service — nothing to retry
    }
  }

  async openExtensionHostConnection(
    authority: string,
    args: IRemoteExtensionHostStartArgs = {},
  ): Promise<IRemoteExtensionHostTunnel> {
    validateAuthority(authority)
    const entry = this._entry(authority)
    if (entry.state === 'disposed') {
      throw new Error('remote connection service is disposed')
    }
    // Management bring-up populates daemonPort/daemonToken and the ssh forward
    // the tunnel reuses. getConnection is idempotent, so an already-up tunnel
    // short-circuits.
    await this.getConnection(authority)

    const reconnectionToken = randomUUID()
    const tunnel = new RemoteExtensionHostTunnel({
      authority,
      connectSocket: async () => {
        if (!entry.isDirect) await this._ensureForward(entry)
        const port = entry.isDirect ? entry.daemonPort : entry.forward!.localPort
        return connectNodeSocket(port, '127.0.0.1')
      },
      buildRequest: (isReconnection) => ({
        token: entry.daemonToken,
        connectionType: RemoteConnectionType.ExtensionHost,
        authority: entry.authority,
        reconnectionToken,
        isReconnection,
        ...(isReconnection ? {} : Object.keys(args).length > 0 ? { args } : {}),
      }),
      logger: this._logger,
      label: `extHost:${authority}`,
    })
    const closeSub = tunnel.onDidClose(() => {
      this._extensionHostTunnels.delete(tunnel)
      closeSub.dispose()
    })
    this._extensionHostTunnels.set(tunnel, closeSub)
    try {
      await tunnel.open()
    } catch (err) {
      this._extensionHostTunnels.delete(tunnel)
      closeSub.dispose()
      tunnel.dispose()
      throw err
    }
    return tunnel
  }

  async stopServer(authority: string): Promise<void> {
    const entry = this._entries.get(authority)
    if (!entry) return
    await this._closeEntry(entry, true)
  }

  async closeConnection(authority: string): Promise<void> {
    const entry = this._entries.get(authority)
    if (!entry) return
    await this._closeEntry(entry, false)
  }

  dropSocketForTesting(authority: string): void {
    const entry = this._entries.get(authority)
    if (!entry) return
    entry.protocol?.getSocket().dispose()
    this._onSocketDisconnected(entry)
  }

  dropExtensionHostSocketForTesting(authority: string): void {
    for (const [tunnel] of this._extensionHostTunnels) {
      if (tunnel.authority === authority) tunnel.dropSocketForTesting()
    }
  }

  // ------------------------- bring-up -------------------------

  private _startBringUp(entry: ConnectionEntry): Promise<IRemoteConnection> {
    if (entry.promise) return entry.promise
    entry.closedByUser = false
    entry.reconnectionToken = randomUUID()
    const promise = this._bringUp(entry).finally(() => {
      if (entry.promise === promise) entry.promise = null
    })
    entry.promise = promise
    return promise
  }

  private async _bringUp(entry: ConnectionEntry): Promise<IRemoteConnection> {
    try {
      const connection = this._isDirect()
        ? await this._bringUpDirect(entry)
        : await this._bringUpViaSsh(entry)
      entry.connection = connection
      this._fireState(entry, 'connected')
      return connection
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this._logger.error(`[remote:${entry.authority}] bring-up failed: ${message}`)
      this._teardownConnection(entry)
      this._teardownDirect(entry)
      this._fireState(entry, 'failed', message)
      throw err
    }
  }

  private _isDirect(): boolean {
    const cmd = this._remoteServerCmd?.trim()
    return cmd !== undefined && cmd !== ''
  }

  private async _bringUpViaSsh(entry: ConnectionEntry): Promise<RemoteConnection> {
    this._fireState(entry, 'deploying')
    const info = await this._ensureDaemon(entry)
    entry.daemonPort = info.port
    entry.daemonToken = info.token
    this._fireState(entry, 'forwarding')
    await this._ensureForward(entry)
    this._fireState(entry, 'handshaking')
    return this._connectFresh(entry, entry.forward!.localPort)
  }

  private async _bringUpDirect(entry: ConnectionEntry): Promise<RemoteConnection> {
    this._fireState(entry, 'deploying')
    const { command, args } = this._resolveDirectCommand()
    const dataDir = join(
      this._getUserDataDir(),
      'remote-direct',
      sanitizeAuthority(entry.authority),
    )
    const proc = new ManagedChildProcess(
      this._spawn(command, [...args, 'serve', '--data-dir', dataDir], {
        env: buildChildEnv(process.env),
      }),
      { logger: this._logger, label: `remote-direct:${entry.authority}` },
    )
    entry.directProcess = proc
    entry.isDirect = true
    const directSubs = new DisposableStore()
    directSubs.add(
      proc.onStderr((chunk) => {
        this._logger.warn(`[remote:${entry.authority}] ${decodeDiagnostic(chunk).trim()}`)
      }),
    )
    directSubs.add(proc.onDidExit((exit) => this._onDirectExited(entry, proc, exit)))
    entry.directSubs = directSubs
    const info = await this._waitForDirectInfo(entry, proc)
    entry.daemonPort = info.port
    entry.daemonToken = info.token
    this._fireState(entry, 'handshaking')
    return this._connectFresh(entry, info.port)
  }

  private _resolveDirectCommand(): { command: string; args: readonly string[] } {
    const custom = this._remoteServerCmd!.trim()
    if (custom.startsWith('[')) {
      let parsed: unknown
      try {
        parsed = JSON.parse(custom)
      } catch (err) {
        throw new Error(`UNIVERSE_REMOTE_SERVER_CMD is not valid JSON: ${(err as Error).message}`)
      }
      if (!Array.isArray(parsed) || parsed.length === 0) {
        throw new Error(
          'UNIVERSE_REMOTE_SERVER_CMD JSON form must be a non-empty [command, ...args] array',
        )
      }
      const command = parsed[0]
      if (typeof command !== 'string') {
        throw new Error('UNIVERSE_REMOTE_SERVER_CMD JSON form command must be a string')
      }
      const args = parsed.slice(1).map((a) => {
        if (typeof a !== 'string') {
          throw new Error('UNIVERSE_REMOTE_SERVER_CMD JSON form args must be strings')
        }
        return a
      })
      return { command, args }
    }
    const parts = custom.split(/\s+/)
    return { command: parts[0]!, args: parts.slice(1) }
  }

  private async _ensureDaemon(entry: ConnectionEntry): Promise<IRemoteDaemonInfo> {
    const authority = entry.authority
    const check = await this._deployer.checkRemoteServer(authority)
    switch (check.state) {
      case 'running': {
        if (check.info.serverVersion !== this._deployer.serverVersion) {
          this._logger.warn(
            `[remote:${authority}] daemon version ${check.info.serverVersion} != local ${this._deployer.serverVersion}; restarting`,
          )
          await this._deployer.stopRemoteDaemon(authority)
          return this._deployer.startRemoteDaemon(authority)
        }
        return check.info
      }
      case 'not-running':
        return this._deployer.startRemoteDaemon(authority)
      case 'not-deployed': {
        this._logger.info(`[remote:${authority}] not deployed (${check.reason}); deploying`)
        await this._deployer.deployRemoteServer(authority, this._logger)
        return this._deployer.startRemoteDaemon(authority)
      }
      case 'error':
        throw new Error(`remote check failed for '${authority}': ${check.message}`)
    }
  }

  private async _ensureForward(entry: ConnectionEntry): Promise<void> {
    if (entry.forward && !entry.forward.process.exited) return
    const { localPort, process, stderrSub } = await this._deployer.createForward(
      entry.authority,
      entry.daemonPort,
      this._logger,
    )
    const exitSub = process.onDidExit(() => this._onForwardExited(entry, process))
    entry.forward = { localPort, process, exitSub, stderrSub }
  }

  private async _connectFresh(
    entry: ConnectionEntry,
    localPort: number,
  ): Promise<RemoteConnection> {
    const socket = await connectNodeSocket(localPort, '127.0.0.1')
    let residual: Uint8Array
    try {
      residual = (await performClientHandshake(socket, this._request(entry, false))).residual
    } catch (err) {
      socket.dispose()
      throw err
    }
    const protocol = new PersistentProtocol({ socket, initialChunk: residual })
    const client = new ChannelClient(protocol, true, binaryCodec)
    let info: IRemoteEnvironment
    try {
      const handshake = ProxyChannel.toService<IRemoteHandshakeService>(
        client.getChannel(RemoteChannels.Handshake),
      )
      info = await withTimeout(
        handshake.getInfo(),
        HANDSHAKE_TIMEOUT_MS,
        `remote '${entry.authority}' handshake getInfo timed out after ${HANDSHAKE_TIMEOUT_MS}ms`,
      )
      if (info.protocolVersion !== REMOTE_PROTOCOL_VERSION) {
        throw new Error(
          `remote '${entry.authority}' protocol version mismatch: local=${REMOTE_PROTOCOL_VERSION} server=${info.protocolVersion}`,
        )
      }
    } catch (err) {
      client.dispose()
      protocol.dispose()
      socket.dispose()
      throw err
    }
    const protocolSubs = new DisposableStore()
    protocolSubs.add(protocol.onSocketClose(() => this._onSocketDisconnected(entry)))
    protocolSubs.add(protocol.onSocketTimeout(() => this._onSocketDisconnected(entry)))
    entry.protocolSubs = protocolSubs
    entry.protocol = protocol
    entry.socket = socket
    entry.env = info
    this._logger.info(
      `remote '${entry.authority}' connected os=${info.os} arch=${info.arch} node=${info.nodeVersion} serverVersion=${info.serverVersion} caseSensitive=${info.pathCaseSensitive}`,
    )
    return new RemoteConnection(entry.authority, info, client)
  }

  private _request(
    entry: ConnectionEntry,
    isReconnection: boolean,
  ): Omit<IRemoteConnectionRequest, 'type' | 'protocolVersion'> {
    return {
      token: entry.daemonToken,
      connectionType: RemoteConnectionType.Management,
      authority: entry.authority,
      reconnectionToken: entry.reconnectionToken,
      isReconnection,
    }
  }

  private _waitForDirectInfo(
    entry: ConnectionEntry,
    proc: ManagedChildProcess,
  ): Promise<IRemoteDaemonInfo> {
    return new Promise((resolve, reject) => {
      const decoder = new StringDecoder('utf8')
      let buffer = ''
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        stdoutSub.dispose()
        exitSub.dispose()
        reject(
          new Error(
            `remote '${entry.authority}' direct daemon did not print its info line within ${DIRECT_INFO_TIMEOUT_MS}ms`,
          ),
        )
      }, DIRECT_INFO_TIMEOUT_MS)
      const stdoutSub = proc.onStdout((chunk) => {
        if (settled) return
        buffer += decoder.write(chunk)
        const info = parseDaemonInfoLine(buffer)
        if (!info) return
        settled = true
        clearTimeout(timer)
        stdoutSub.dispose()
        exitSub.dispose()
        resolve(info)
      })
      const exitSub = proc.onDidExit((exit) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        stdoutSub.dispose()
        exitSub.dispose()
        reject(
          new Error(
            `remote '${entry.authority}' direct daemon exited before info (code=${exit.code ?? 'unknown'})`,
          ),
        )
      })
    })
  }

  // ------------------------- reconnection -------------------------

  private _onSocketDisconnected(entry: ConnectionEntry): void {
    if (entry.state !== 'connected') return
    this._fireState(entry, 'reconnecting')
    entry.reconnectAttempt = 0
    entry.reconnectionStart = Date.now()
    this._scheduleReconnect(entry)
  }

  private _scheduleReconnect(entry: ConnectionEntry): void {
    if (entry.reconnectTimer) return
    if (entry.closedByUser || this._disposed) return
    const backoff =
      RECONNECT_BACKOFF_MS[Math.min(entry.reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1)]!
    entry.reconnectTimer = setTimeout(() => {
      entry.reconnectTimer = null
      if (entry.closedByUser || this._disposed || entry.state !== 'reconnecting') return
      if (Date.now() - entry.reconnectionStart >= ProtocolConstants.ReconnectionGraceTime) {
        this._giveUp(entry, 'reconnection grace time exceeded')
        return
      }
      entry.reconnectAttempt++
      void this._attemptReconnect(entry)
    }, backoff)
    entry.reconnectTimer.unref?.()
  }

  private async _attemptReconnect(entry: ConnectionEntry): Promise<void> {
    try {
      if (!entry.isDirect) {
        await this._ensureForward(entry)
      }
      if (entry.closedByUser || this._disposed) return
      const localPort = entry.isDirect ? entry.daemonPort : entry.forward!.localPort
      const socket = await connectNodeSocket(localPort, '127.0.0.1')
      entry.reconnectSocket = socket
      let residual: Uint8Array
      try {
        residual = (await performClientHandshake(socket, this._request(entry, true))).residual
      } catch (err) {
        entry.reconnectSocket = null
        socket.dispose()
        throw err
      }
      if (entry.closedByUser || this._disposed) {
        entry.reconnectSocket = null
        socket.dispose()
        return
      }
      entry.reconnectSocket = null
      const protocol = entry.protocol!
      const oldSocket = entry.socket
      entry.socket = socket
      protocol.beginAcceptReconnection(socket, residual)
      protocol.endAcceptReconnection()
      oldSocket?.dispose()
      entry.reconnectAttempt = 0
      this._fireState(entry, 'connected')
      this._logger.info(`remote '${entry.authority}' reconnected`)
    } catch (err) {
      entry.reconnectSocket = null
      if (this._isPermanentHandshakeError(err)) {
        this._giveUp(entry, err instanceof Error ? err.message : String(err))
        return
      }
      this._logger.warn(
        `remote '${entry.authority}' reconnect attempt ${entry.reconnectAttempt} failed: ${err instanceof Error ? err.message : String(err)}`,
      )
      this._scheduleReconnect(entry)
    }
  }

  private _isPermanentHandshakeError(err: unknown): boolean {
    const code = (err as Partial<RemoteHandshakeError>).code
    return typeof code === 'string' && PERMANENT_RECONNECT_CODES.has(code)
  }

  private _onForwardExited(entry: ConnectionEntry, process: ManagedChildProcess): void {
    if (entry.forward?.process !== process) return
    const forward = entry.forward
    entry.forward = null
    forward.exitSub.dispose()
    forward.stderrSub.dispose()
    forward.process.dispose()
    if (entry.closedByUser || this._disposed) return
    if (entry.state === 'connected') {
      this._logger.warn(`[remote:${entry.authority}] ssh forward exited; reconnecting`)
      this._onSocketDisconnected(entry)
    }
  }

  private _onDirectExited(
    entry: ConnectionEntry,
    proc: ManagedChildProcess,
    exit: ManagedExit,
  ): void {
    if (entry.directProcess !== proc) return
    entry.directProcess = null
    entry.directSubs?.dispose()
    entry.directSubs = null
    proc.dispose()
    if (entry.closedByUser || this._disposed) return
    // During bring-up the in-flight connect path surfaces the failure itself.
    if (entry.state === 'deploying' || entry.state === 'handshaking') return
    this._logger.warn(
      `[remote:${entry.authority}] direct daemon exited code=${exit.code ?? 'unknown'}`,
    )
    this._giveUp(entry, `direct daemon exited (code=${exit.code ?? 'unknown'})`)
  }

  private _giveUp(entry: ConnectionEntry, reason: string): void {
    if (entry.state === 'failed' || entry.state === 'disposed') return
    this._logger.error(`remote '${entry.authority}' giving up: ${reason}`)
    entry.connection?.fireClose()
    this._teardownConnection(entry)
    this._fireState(entry, 'failed', reason)
  }

  // ------------------------- teardown -------------------------

  private _teardownForRetry(entry: ConnectionEntry): void {
    entry.closedByUser = true
    if (entry.reconnectTimer) {
      clearTimeout(entry.reconnectTimer)
      entry.reconnectTimer = null
    }
    entry.protocol?.sendDisconnect()
    entry.connection?.fireClose()
    this._teardownConnection(entry)
    this._teardownDirect(entry)
  }

  private async _closeEntry(entry: ConnectionEntry, stopDaemon: boolean): Promise<void> {
    if (entry.state === 'disposed') return
    this._teardownForRetry(entry)
    if (stopDaemon && !entry.isDirect) {
      try {
        await this._deployer.stopRemoteDaemon(entry.authority)
      } catch (err) {
        this._logger.warn(
          `[remote:${entry.authority}] stop daemon failed: ${(err as Error).message}`,
        )
      }
    }
    entry.closedByUser = false
    this._fireState(entry, 'idle')
  }

  private _teardownConnection(entry: ConnectionEntry): void {
    if (entry.reconnectTimer) {
      clearTimeout(entry.reconnectTimer)
      entry.reconnectTimer = null
    }
    entry.reconnectSocket?.dispose()
    entry.reconnectSocket = null
    const connection = entry.connection
    entry.connection = null
    connection?.dispose()
    const protocol = entry.protocol
    entry.protocol = null
    entry.protocolSubs?.dispose()
    entry.protocolSubs = null
    protocol?.dispose()
    entry.socket?.dispose()
    entry.socket = null
    entry.env = null
    this._teardownForward(entry)
  }

  private _teardownForward(entry: ConnectionEntry): void {
    const forward = entry.forward
    entry.forward = null
    if (forward) {
      forward.exitSub.dispose()
      forward.stderrSub.dispose()
      forward.process.dispose()
    }
  }

  private _teardownDirect(entry: ConnectionEntry): void {
    const proc = entry.directProcess
    entry.directProcess = null
    entry.directSubs?.dispose()
    entry.directSubs = null
    proc?.dispose()
  }

  // ------------------------- bookkeeping -------------------------

  private _entry(authority: string): ConnectionEntry {
    let entry = this._entries.get(authority)
    if (!entry) {
      entry = {
        authority,
        state: 'idle',
        connection: null,
        protocol: null,
        socket: null,
        protocolSubs: null,
        env: null,
        promise: null,
        forward: null,
        directProcess: null,
        directSubs: null,
        daemonPort: 0,
        daemonToken: '',
        reconnectionToken: '',
        isDirect: false,
        reconnectTimer: null,
        reconnectSocket: null,
        reconnectAttempt: 0,
        reconnectionStart: 0,
        closedByUser: false,
      }
      this._entries.set(authority, entry)
    }
    return entry
  }

  private _fireState(entry: ConnectionEntry, state: RemoteConnectionState, error?: string): void {
    entry.state = state
    this._onDidChangeState.fire({
      authority: entry.authority,
      state,
      ...(error !== undefined ? { error } : {}),
    })
  }

  override dispose(): void {
    this._disposed = true
    for (const [tunnel, closeSub] of this._extensionHostTunnels) {
      closeSub.dispose()
      tunnel.dispose()
    }
    this._extensionHostTunnels.clear()
    for (const entry of this._entries.values()) {
      entry.closedByUser = true
      entry.state = 'disposed'
      if (entry.reconnectTimer) {
        clearTimeout(entry.reconnectTimer)
        entry.reconnectTimer = null
      }
      entry.protocol?.sendDisconnect()
      entry.connection?.fireClose()
      this._teardownConnection(entry)
      this._teardownDirect(entry)
    }
    this._entries.clear()
    super.dispose()
  }
}
