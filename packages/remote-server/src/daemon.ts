/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  TCP daemon: accepts connections on 127.0.0.1, validates the control-frame
 *  handshake (token / protocol version / connection type), and hands each
 *  Management connection over to a ManagementConnection. Reconnects re-attach a
 *  grace-held connection by its reconnection token; sockets that drop are held
 *  for ProtocolConstants.ReconnectionGraceTime before the connection is disposed.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes } from 'node:crypto'
import { createServer, type Server, type Socket as NetSocket } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  NullLogger,
  ProtocolConstants,
  REMOTE_PROTOCOL_VERSION,
  RemoteConnectionErrorCode,
  RemoteConnectionType,
  decodeControlJson,
  encodeControlJson,
  readFirstControlFrame,
  writeControlFrame,
  type IDisposable,
  type ILogger,
  type IRemoteConnectionRequest,
  type IRemoteConnectionResponse,
  type ISocket,
} from '@universe-editor/platform'
import { NodeSocket } from '@universe-editor/node-services'
import type { PtySpawner } from '@universe-editor/node-services'
import { ManagementConnection } from './connection.js'
import { ExtensionHostConnection } from './extensionHostConnection.js'
import { SERVER_VERSION } from './version.js'

export interface DaemonOptions {
  readonly port?: number
  readonly host?: string
  readonly token?: string
  readonly logger?: ILogger
  readonly serverVersion?: string
  /** Fake pty spawner for daemon integration tests (no native node-pty). */
  readonly terminalSpawner?: PtySpawner
  /** Absolute path to the extension-host bootstrap (injectable for tests). */
  readonly extensionHostEntry?: string
  /** Daemon data dir (`--data-dir`): threaded to host-scoped state/log paths. */
  readonly dataDir?: string
  /** Grace timeout override for tests (default: ReconnectionGraceTime). */
  readonly graceTimeMs?: number
}

export interface RunningDaemon {
  readonly port: number
  readonly token: string
  dispose(): Promise<void>
}

/** Common surface shared by every per-connection daemon entry. */
interface ServerConnection extends IDisposable {
  readonly reconnectionToken: string
  acceptReconnection(socket: ISocket, residual: Uint8Array | null): void
}

interface ConnectionEntry {
  readonly conn: ServerConnection
  readonly authority: string
  graceTimer: ReturnType<typeof setTimeout> | null
}

const HANDSHAKE_TIMEOUT_MS = 10_000

/** Default host bootstrap: bundled alongside the daemon entry (same resource
 *  resolution as server.ts's watcher child). */
function resolveExtensionHostEntry(): string {
  return fileURLToPath(new URL('./extension-host/bootstrap.js', import.meta.url))
}

export async function createDaemon(opts: DaemonOptions = {}): Promise<RunningDaemon> {
  const log = opts.logger ?? new NullLogger()
  const token = opts.token ?? randomBytes(24).toString('hex')
  const serverVersion = opts.serverVersion ?? SERVER_VERSION

  const entries = new Map<string, ConnectionEntry>()
  const rawSockets = new Set<NetSocket>()
  const server: Server = createServer()

  function clearGraceTimer(entry: ConnectionEntry): void {
    if (entry.graceTimer) {
      clearTimeout(entry.graceTimer)
      entry.graceTimer = null
    }
  }

  function expireGrace(entry: ConnectionEntry): void {
    if (entries.get(entry.conn.reconnectionToken) !== entry) return
    log.info(`[remote-daemon] grace expired for ${entry.authority}; disposing connection`)
    entries.delete(entry.conn.reconnectionToken)
    entry.conn.dispose()
  }

  function startGraceTimer(conn: ServerConnection): void {
    const entry = entries.get(conn.reconnectionToken)
    if (!entry) return
    clearGraceTimer(entry)
    const graceMs = opts.graceTimeMs ?? ProtocolConstants.ReconnectionGraceTime
    log.info(`[remote-daemon] holding connection for ${entry.authority} (grace ${graceMs}ms)`)
    entry.graceTimer = setTimeout(() => expireGrace(entry), graceMs)
  }

  function removeEntry(conn: ServerConnection): void {
    const entry = entries.get(conn.reconnectionToken)
    if (!entry) return
    clearGraceTimer(entry)
    entries.delete(conn.reconnectionToken)
  }

  function shortenSameAuthorityGrace(authority: string): void {
    const shortGraceMs =
      opts.graceTimeMs !== undefined
        ? opts.graceTimeMs
        : ProtocolConstants.ReconnectionShortGraceTime
    for (const entry of entries.values()) {
      if (entry.authority !== authority || !entry.graceTimer) continue
      clearTimeout(entry.graceTimer)
      log.info(`[remote-daemon] shortening grace for ${authority} (fresh connect arrived)`)
      entry.graceTimer = setTimeout(() => expireGrace(entry), shortGraceMs)
    }
  }

  function handleSocket(socket: ISocket): void {
    void (async () => {
      try {
        const { data, residual } = await readFirstControlFrame(socket, HANDSHAKE_TIMEOUT_MS)
        const req = decodeControlJson<IRemoteConnectionRequest>(data)
        log.info(
          `[remote-daemon] handshake: connectionType=${req.connectionType} authority=${req.authority} isReconnection=${req.isReconnection}`,
        )

        const fail = (response: IRemoteConnectionResponse): void => {
          writeControlFrame(socket, encodeControlJson(response))
          socket.end()
        }

        if (req.token !== token) {
          log.warn('[remote-daemon] handshake rejected: invalid token')
          fail({
            type: 'error',
            code: RemoteConnectionErrorCode.InvalidToken,
            message: 'invalid token',
          })
          return
        }
        if (req.protocolVersion !== REMOTE_PROTOCOL_VERSION) {
          log.warn(`[remote-daemon] handshake rejected: protocol version ${req.protocolVersion}`)
          fail({
            type: 'error',
            code: RemoteConnectionErrorCode.VersionMismatch,
            message: `protocol version ${req.protocolVersion} != ${REMOTE_PROTOCOL_VERSION}`,
          })
          return
        }
        if (
          req.connectionType !== RemoteConnectionType.Management &&
          req.connectionType !== RemoteConnectionType.ExtensionHost
        ) {
          log.warn(
            `[remote-daemon] handshake rejected: unknown connection type ${req.connectionType}`,
          )
          fail({
            type: 'error',
            code: RemoteConnectionErrorCode.Unknown,
            message: `unknown connection type ${req.connectionType}`,
          })
          return
        }

        if (!req.isReconnection) {
          if (entries.has(req.reconnectionToken)) {
            log.warn('[remote-daemon] handshake rejected: duplicate reconnection token')
            fail({
              type: 'error',
              code: RemoteConnectionErrorCode.DuplicateReconnectionToken,
              message: 'reconnection token is already in use',
            })
            return
          }
          shortenSameAuthorityGrace(req.authority)
          // ok must be written before the connection is constructed so the
          // client's own readFirstControlFrame never sees a KeepAlive first.
          writeControlFrame(socket, encodeControlJson({ type: 'ok' }))
          const conn: ServerConnection =
            req.connectionType === RemoteConnectionType.ExtensionHost
              ? new ExtensionHostConnection({
                  reconnectionToken: req.reconnectionToken,
                  authority: req.authority,
                  socket,
                  residual,
                  logger: log,
                  hostEntryPath: opts.extensionHostEntry ?? resolveExtensionHostEntry(),
                  ...(req.args?.env !== undefined ? { env: req.args.env } : {}),
                  ...(req.args?.execArgv !== undefined ? { execArgv: req.args.execArgv } : {}),
                  ...(opts.dataDir !== undefined ? { dataDir: opts.dataDir } : {}),
                  onSocketClose: (c) => startGraceTimer(c),
                  onConnectionClosed: (c) => removeEntry(c),
                })
              : new ManagementConnection({
                  reconnectionToken: req.reconnectionToken,
                  authority: req.authority,
                  socket,
                  residual,
                  serverVersion,
                  logger: log,
                  onSocketClose: (c) => startGraceTimer(c),
                  ...(opts.terminalSpawner !== undefined
                    ? { terminalSpawner: opts.terminalSpawner }
                    : {}),
                  ...(opts.dataDir !== undefined
                    ? { agentBinaryDir: join(opts.dataDir, 'agent-bin') }
                    : {}),
                })
          entries.set(req.reconnectionToken, {
            conn,
            authority: req.authority,
            graceTimer: null,
          })
        } else {
          const entry = entries.get(req.reconnectionToken)
          if (!entry) {
            log.warn('[remote-daemon] handshake rejected: unknown reconnection token')
            fail({
              type: 'error',
              code: RemoteConnectionErrorCode.UnknownReconnectionToken,
              message: 'unknown reconnection token',
            })
            return
          }
          writeControlFrame(socket, encodeControlJson({ type: 'ok' }))
          entry.conn.acceptReconnection(socket, residual)
          clearGraceTimer(entry)
        }
      } catch (err) {
        log.warn(
          `[remote-daemon] handshake failed: ${err instanceof Error ? err.message : String(err)}`,
        )
        try {
          socket.end()
        } catch {
          // already closed
        }
      }
    })()
  }

  server.on('connection', (rawSocket: NetSocket) => {
    rawSockets.add(rawSocket)
    rawSocket.on('close', () => rawSockets.delete(rawSocket))
    handleSocket(new NodeSocket(rawSocket))
  })

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => reject(err)
    server.once('error', onError)
    server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', () => {
      server.off('error', onError)
      resolve()
    })
  })
  server.on('error', (err) => log.warn(`[remote-daemon] server error: ${err.message}`))

  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('failed to resolve daemon address')
  }
  const port = address.port
  log.info(`[remote-daemon] listening on 127.0.0.1:${port}`)

  return {
    port,
    token,
    async dispose(): Promise<void> {
      for (const entry of entries.values()) {
        clearGraceTimer(entry)
        entry.conn.dispose()
      }
      entries.clear()
      for (const raw of rawSockets) {
        try {
          raw.destroy()
        } catch {
          // already closed
        }
      }
      rawSockets.clear()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      log.info('[remote-daemon] stopped')
    },
  }
}
