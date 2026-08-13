/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Main-side owner of remote server connections. Lazily spawns (idempotently,
 *  memoized per authority) a remote universe-editor-server over ssh (or a
 *  configured command) and bridges its stdio into a ChannelPair, so the file /
 *  search / watcher services can reach remote channels through ProxyChannel just
 *  like a local peer. Handles the handshake (protocol-version gate) and crash
 *  recovery with bounded exponential backoff.
 *--------------------------------------------------------------------------------------------*/

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import {
  ChannelPair,
  createDecorator,
  createNamedLogger,
  Disposable,
  DisposableStore,
  Emitter,
  ProxyChannel,
  REMOTE_PROTOCOL_VERSION,
  RemoteChannels,
  type Event,
  type IChannel,
  type IChannelClient,
  type ILogger,
  ILoggerService,
  type IRemoteHandshakeInfo,
  type IRemoteHandshakeService,
} from '@universe-editor/platform'
import { StdioFramingProtocol } from '@universe-editor/extensions-common'
import { buildChildEnv } from '../process/env.js'
import { decodeDiagnostic } from '../process/decode.js'
import { ManagedChildProcess, type ManagedExit } from '../process/managedChildProcess.js'

export interface IRemoteConnection {
  readonly authority: string
  readonly info: IRemoteHandshakeInfo
  getChannel(name: string): IChannel
  readonly onDidClose: Event<void>
}

export interface IRemoteConnectionService {
  readonly _serviceBrand: undefined
  getConnection(authority: string): Promise<IRemoteConnection>
  dispose(): void
}

export const IRemoteConnectionService =
  createDecorator<IRemoteConnectionService>('remoteConnectionService')

/** Spawner abstraction — injectable for tests so we don't launch real processes. */
export type RemoteSpawner = (
  command: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv },
) => ChildProcessWithoutNullStreams

const defaultSpawner: RemoteSpawner = (command, args, options) =>
  spawn(command, [...args], {
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
  })

const HANDSHAKE_TIMEOUT_MS = 10_000
const GRACEFUL_STOP_MS = 2_000
const RESTART_WINDOW_MS = 60_000
const MAX_RESTARTS = 3
const RESTART_BASE_DELAY_MS = 1_000

/**
 * Resolve `[command, ...args]` for a remote server spawn. `remoteServerCmd`
 * (UNIVERSE_REMOTE_SERVER_CMD) overrides the default `ssh`; it is self-contained
 * so the authority is never appended. The default appends `<authority>` into an
 * ssh argv, so the authority is validated against option injection.
 */
export function resolveRemoteServerCommand(
  remoteServerCmd: string | undefined,
  authority: string,
): { command: string; args: readonly string[] } {
  if (authority.length === 0) {
    throw new Error('remote connection requires a non-empty authority')
  }
  const custom = remoteServerCmd?.trim()
  if (custom) {
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
  if (authority.startsWith('-')) {
    throw new Error(`remote authority must not start with '-' (ssh option injection): ${authority}`)
  }
  return {
    command: 'ssh',
    args: ['-T', '-o', 'BatchMode=yes', authority, 'universe-editor-server'],
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

type ConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'disposed'

interface ConnectionEntry {
  authority: string
  state: ConnectionState
  connection: RemoteConnection | null
  promise: Promise<IRemoteConnection> | null
  restartTimes: number[]
  reconnectTimer: ReturnType<typeof setTimeout> | null
  proc: ManagedChildProcess | null
  store: DisposableStore | null
  plannedExit: boolean
}

class RemoteConnection implements IRemoteConnection {
  private readonly _onDidClose = new Emitter<void>()
  readonly onDidClose: Event<void> = this._onDidClose.event

  constructor(
    readonly authority: string,
    readonly info: IRemoteHandshakeInfo,
    private readonly _client: IChannelClient,
  ) {}

  getChannel(name: string): IChannel {
    return this._client.getChannel(name)
  }

  fireClose(): void {
    this._onDidClose.fire()
  }

  dispose(): void {
    this._onDidClose.dispose()
  }
}

export class RemoteConnectionMainService extends Disposable implements IRemoteConnectionService {
  declare readonly _serviceBrand: undefined

  private readonly _logger: ILogger
  private readonly _entries = new Map<string, ConnectionEntry>()
  private _disposed = false

  constructor(
    private readonly _spawn: RemoteSpawner = defaultSpawner,
    private readonly _remoteServerCmd: string | undefined = undefined,
    @ILoggerService loggerService?: ILoggerService,
  ) {
    super()
    this._logger = createNamedLogger(loggerService, {
      id: 'remoteConnection',
      name: 'Remote Connection',
    })
  }

  getConnection(authority: string): Promise<IRemoteConnection> {
    const entry = this._entry(authority)
    if (entry.state === 'failed') {
      return Promise.reject(
        new Error(
          `remote connection '${authority}' failed (crash loop); retry later or restart the app`,
        ),
      )
    }
    if (entry.state === 'disposed') {
      return Promise.reject(new Error('remote connection service is disposed'))
    }
    if (entry.connection) return Promise.resolve(entry.connection)
    if (entry.promise) return entry.promise
    if (entry.reconnectTimer) {
      clearTimeout(entry.reconnectTimer)
      entry.reconnectTimer = null
    }
    return this._startAttempt(entry)
  }

  private _startAttempt(entry: ConnectionEntry): Promise<IRemoteConnection> {
    if (entry.promise) return entry.promise
    entry.state = 'connecting'
    const promise = this._connect(entry).finally(() => {
      if (entry.promise === promise) entry.promise = null
    })
    entry.promise = promise
    return promise
  }

  private async _connect(entry: ConnectionEntry): Promise<IRemoteConnection> {
    const { command, args } = resolveRemoteServerCommand(this._remoteServerCmd, entry.authority)
    let proc: ManagedChildProcess
    try {
      proc = new ManagedChildProcess(
        this._spawn(command, args, { env: buildChildEnv(process.env) }),
        {
          logger: this._logger,
          label: entry.authority,
        },
      )
    } catch (err) {
      this._logger.warn(`remote '${entry.authority}' spawn failed: ${(err as Error).message}`)
      throw err
    }
    entry.proc = proc
    const store = new DisposableStore()
    entry.store = store
    store.add(proc)

    const stdoutDecoder = new StringDecoder('utf8')
    const onStdout = new Emitter<string>()
    store.add(proc.onStdout((data: Buffer) => onStdout.fire(stdoutDecoder.write(data))))
    store.add(
      proc.onStderr((data: Buffer) => {
        this._logger.warn(`[remote:${entry.authority}] ${decodeDiagnostic(data).trim()}`)
      }),
    )

    const protocol = store.add(
      new StdioFramingProtocol({
        write: (frame) => {
          void proc.writeStdin(frame).catch((err: unknown) => {
            this._logger.debug(
              `[remote:${entry.authority}] writeStdin failed: ${(err as Error).message}`,
            )
          })
        },
        onData: onStdout.event,
      }),
    )
    const pair = store.add(new ChannelPair(protocol))
    const client = pair.client

    store.add(proc.onDidExit((exit) => this._onProcExit(entry, proc, exit)))

    this._logger.info(
      `remote '${entry.authority}' spawn pid=${proc.pid ?? 'unknown'} cmd=${command}`,
    )

    const handshake = ProxyChannel.toService<IRemoteHandshakeService>(
      client.getChannel(RemoteChannels.Handshake),
    )
    let info: IRemoteHandshakeInfo
    try {
      info = await withTimeout(
        handshake.getInfo(),
        HANDSHAKE_TIMEOUT_MS,
        `remote '${entry.authority}' handshake timed out after ${HANDSHAKE_TIMEOUT_MS}ms`,
      )
    } catch (err) {
      entry.plannedExit = true
      entry.proc = null
      entry.store = null
      store.dispose()
      throw err
    }
    if (info.protocolVersion !== REMOTE_PROTOCOL_VERSION) {
      entry.plannedExit = true
      entry.proc = null
      entry.store = null
      store.dispose()
      throw new Error(
        `remote '${entry.authority}' protocol version mismatch: local=${REMOTE_PROTOCOL_VERSION} server=${info.protocolVersion}`,
      )
    }

    const connection = new RemoteConnection(entry.authority, info, client)
    entry.connection = connection
    entry.state = 'connected'
    this._logger.info(
      `remote '${entry.authority}' connected os=${info.os} arch=${info.arch} caseSensitive=${info.pathCaseSensitive}`,
    )
    return connection
  }

  private _onProcExit(entry: ConnectionEntry, proc: ManagedChildProcess, exit: ManagedExit): void {
    if (entry.proc !== proc) return
    entry.proc = null
    const store = entry.store
    entry.store = null

    const conn = entry.connection
    entry.connection = null
    if (conn) {
      conn.fireClose()
      conn.dispose()
    }
    store?.dispose()

    const planned = entry.plannedExit
    entry.plannedExit = false
    if (planned) {
      entry.state = 'idle'
      return
    }
    if (this._disposed || entry.state === 'disposed') return

    this._logger.warn(
      `remote '${entry.authority}' exited code=${exit.code ?? 'unknown'}${exit.error ? ` error=${exit.error}` : ''}`,
    )

    const now = Date.now()
    entry.restartTimes = entry.restartTimes.filter((t) => now - t < RESTART_WINDOW_MS)
    entry.restartTimes.push(now)
    if (entry.restartTimes.length > MAX_RESTARTS) {
      entry.state = 'failed'
      this._logger.error(
        `remote '${entry.authority}' crashed ${entry.restartTimes.length} times within ${RESTART_WINDOW_MS}ms; giving up`,
      )
      return
    }
    entry.state = 'reconnecting'
    const delay = RESTART_BASE_DELAY_MS * 2 ** (entry.restartTimes.length - 1)
    this._logger.warn(`remote '${entry.authority}' reconnecting in ${delay}ms`)
    entry.reconnectTimer = setTimeout(() => {
      entry.reconnectTimer = null
      if (!this._disposed && entry.state === 'reconnecting') {
        void this._startAttempt(entry).catch(() => undefined)
      }
    }, delay)
    entry.reconnectTimer.unref?.()
  }

  private _entry(authority: string): ConnectionEntry {
    let entry = this._entries.get(authority)
    if (!entry) {
      entry = {
        authority,
        state: 'idle',
        connection: null,
        promise: null,
        restartTimes: [],
        reconnectTimer: null,
        proc: null,
        store: null,
        plannedExit: false,
      }
      this._entries.set(authority, entry)
    }
    return entry
  }

  override dispose(): void {
    this._disposed = true
    for (const entry of this._entries.values()) {
      entry.state = 'disposed'
      entry.plannedExit = true
      if (entry.reconnectTimer) {
        clearTimeout(entry.reconnectTimer)
        entry.reconnectTimer = null
      }
      const conn = entry.connection
      entry.connection = null
      if (conn) {
        conn.fireClose()
        conn.dispose()
      }
      const proc = entry.proc
      const store = entry.store
      entry.proc = null
      entry.store = null
      if (proc && !proc.exited) {
        proc.endStdin()
        const grace = setTimeout(() => {
          if (!proc.exited) proc.kill()
          store?.dispose()
        }, GRACEFUL_STOP_MS)
        grace.unref?.()
      } else {
        store?.dispose()
      }
    }
    this._entries.clear()
    super.dispose()
  }
}
