/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  ExtensionHostConnection — a logical extension-host connection over a raw byte
 *  pipe. The daemon forks the extension-host bootstrap (its own node) and pumps
 *  bytes between the TCP protocol and the child's stdio VERBATIM: it never
 *  decodes the host RPC, so URI transforms and StartSpec semantics live inside
 *  the host process (a later phase). A socket loss only signals the daemon to
 *  hold the connection in grace (the child stays alive); a reconnect re-attaches
 *  the protocol and replays the unacknowledged queue. An explicit Disconnect
 *  frame or grace expiry gracefully stops the child (stdin EOF first, SIGKILL
 *  backstop); a child crash is reported in-band as a `{type:'exit'}` Control
 *  frame before the connection is torn down.
 *--------------------------------------------------------------------------------------------*/

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, type WriteStream } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  Disposable,
  PersistentProtocol,
  URI,
  encodeControlJson,
  type ILogger,
  type ISocket,
} from '@universe-editor/platform'
import { buildChildEnv } from '@universe-editor/node-services'

/** Grace period after the host's stdin EOF before the child is force-killed. */
const EXT_HOST_GRACEFUL_STOP_MS = 2000

export interface ExtensionHostConnectionOptions {
  readonly reconnectionToken: string
  readonly authority: string
  readonly socket: ISocket
  readonly residual: Uint8Array | null
  readonly logger: ILogger
  /** Absolute path to the host bootstrap (injectable for tests). */
  readonly hostEntryPath: string
  readonly env?: Record<string, string>
  readonly execArgv?: readonly string[]
  /** Daemon data dir (`--data-dir`): host-scoped state + logs live under it. */
  readonly dataDir?: string
  /** Socket dropped: hold the connection in grace (do NOT kill the child). */
  readonly onSocketClose: (conn: ExtensionHostConnection) => void
  /** Explicit Disconnect or child exit: remove the connection from the daemon now. */
  readonly onConnectionClosed: (conn: ExtensionHostConnection) => void
}

/** Walk up from `start` until a directory containing `pnpm-workspace.yaml`. */
function findRepoRoot(start: string): string | undefined {
  let dir = start
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}

function sanitizeAuthority(authority: string): string {
  return authority.replace(/[^A-Za-z0-9._-]/g, '_')
}

/** First candidate that exists on disk, or undefined when none do. */
function firstExisting(candidates: readonly string[]): string | undefined {
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * Server-resolved host env. Paths come from the bundle (deploy: `dist-bundle/`
 * after `npm install`; dev: the repo tree) and the daemon data dir. The client's
 * own env (`opts.env`) carries only host-independent fields (workspace root,
 * locale, disabled ids) and never overrides these.
 */
function resolveServerEnv(dataDir: string | undefined): Record<string, string> {
  const bundleDir = fileURLToPath(new URL('./', import.meta.url))
  const repoRoot = findRepoRoot(bundleDir)

  const builtin =
    firstExisting([
      path.join(bundleDir, 'extensions'),
      ...(repoRoot ? [path.join(repoRoot, 'extensions')] : []),
    ]) ?? path.join(bundleDir, 'extensions')

  const tslsCli = firstExisting([
    path.join(bundleDir, 'node_modules/typescript-language-server/lib/cli.mjs'),
    ...(repoRoot
      ? [
          path.join(
            repoRoot,
            'vendor/typescript-language-server/node_modules/typescript-language-server/lib/cli.mjs',
          ),
        ]
      : []),
  ])
  const tsserver = firstExisting([
    path.join(bundleDir, 'node_modules/typescript/lib/tsserver.js'),
    ...(repoRoot
      ? [
          path.join(
            repoRoot,
            'vendor/typescript-language-server/node_modules/typescript/lib/tsserver.js',
          ),
        ]
      : []),
  ])

  const env: Record<string, string> = { UNIVERSE_BUILTIN_EXTENSIONS_DIR: builtin }
  if (tslsCli && tsserver) {
    env.UNIVERSE_TS_SERVER_KIND = 'tsls'
    env.UNIVERSE_TSLS_CLI = tslsCli
    env.UNIVERSE_TSLS_TSSERVER = tsserver
  }

  if (dataDir) {
    const userExtensions = path.join(dataDir, 'user-extensions')
    mkdirSync(userExtensions, { recursive: true })
    env.UNIVERSE_USER_EXTENSIONS_DIR = userExtensions
    const globalStorage = path.join(dataDir, 'data', 'extensionGlobalStorage')
    mkdirSync(globalStorage, { recursive: true })
    env.UNIVERSE_GLOBAL_STORAGE_DIR = globalStorage
  }
  return env
}

export class ExtensionHostConnection extends Disposable {
  readonly reconnectionToken: string
  readonly authority: string

  private readonly _logger: ILogger
  private readonly _protocol: PersistentProtocol
  private readonly _onSocketClose: (conn: ExtensionHostConnection) => void
  private readonly _onConnectionClosed: (conn: ExtensionHostConnection) => void

  private _socket: ISocket
  private _child: ChildProcessWithoutNullStreams | null = null
  private _childExited = false
  private _stoppingChild = false
  private _disposed = false

  constructor(opts: ExtensionHostConnectionOptions) {
    super()
    this.reconnectionToken = opts.reconnectionToken
    this.authority = opts.authority
    this._logger = opts.logger
    this._socket = opts.socket
    this._onSocketClose = opts.onSocketClose
    this._onConnectionClosed = opts.onConnectionClosed

    this._protocol = this._register(
      new PersistentProtocol({ socket: opts.socket, initialChunk: opts.residual }),
    )

    // A socket loss is NOT a permanent close: notify the daemon to hold the
    // connection in grace, keeping the child alive for a transparent reconnect.
    this._register(
      this._protocol.onSocketClose(() => {
        opts.logger.info(`[remote:${opts.authority}] extension-host socket closed (grace)`)
        this._onSocketClose(this)
      }),
    )

    // A Disconnect frame is an explicit client close: stop the child now and drop
    // the connection from the daemon table (no grace). Defer the dispose out of
    // the protocol's fire loop so the remaining teardown runs safely.
    this._register(
      this._protocol.onDidClose(() => {
        opts.logger.info(`[remote:${opts.authority}] extension-host disconnected (explicit)`)
        this._stopChildGraceful()
        this._onConnectionClosed(this)
        queueMicrotask(() => this.dispose())
      }),
    )

    // Pump client → child verbatim (no framing knowledge). Backpressure is not
    // modeled this phase — the host's RPC is small control frames.
    this._register(
      this._protocol.onMessage((data) => {
        if (this._child && !this._childExited && this._child.stdin.writable) {
          this._child.stdin.write(data)
        }
      }),
    )

    this._spawnChild(opts)
    opts.logger.info(
      `[remote:${opts.authority}] extension-host connection established (token ${opts.reconnectionToken.slice(0, 8)}…)`,
    )
  }

  acceptReconnection(socket: ISocket, residual: Uint8Array | null): void {
    if (this._disposed) return
    const oldSocket = this._socket
    this._socket = socket
    this._protocol.beginAcceptReconnection(socket, residual)
    this._protocol.endAcceptReconnection()
    try {
      oldSocket.dispose()
    } catch {
      // already closed
    }
  }

  private _spawnChild(opts: ExtensionHostConnectionOptions): void {
    // The daemon injects the authority the host consumes and fills the
    // server-resolved paths (builtin/user extensions, global storage, TS server).
    const clientEnv = { ...opts.env }
    // The client sends the POSIX `remote-ssh` path as the workspace root; resolve
    // it to the server's native form (no-op on POSIX, `/C:/…` → `C:\…` on Windows).
    if (clientEnv.UNIVERSE_WORKSPACE_ROOT !== undefined) {
      clientEnv.UNIVERSE_WORKSPACE_ROOT = URI.from({
        scheme: 'file',
        path: clientEnv.UNIVERSE_WORKSPACE_ROOT,
      }).fsPath
    }
    const env = buildChildEnv(process.env, {
      overrides: {
        ...clientEnv,
        ...resolveServerEnv(opts.dataDir),
        UNIVERSE_REMOTE_AUTHORITY: opts.authority,
      },
    })

    let child: ChildProcessWithoutNullStreams
    try {
      child = spawn(process.execPath, [...(opts.execArgv ?? []), opts.hostEntryPath], {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
      })
    } catch (err) {
      opts.logger.warn(
        `[remote:${opts.authority}] extension-host spawn failed: ${(err as Error).message}`,
      )
      this._sendExit(null)
      this._protocol.sendDisconnect()
      this._onConnectionClosed(this)
      this.dispose()
      return
    }
    this._child = child

    // Persist the host's stderr to a per-authority file under the data dir so
    // remote extension diagnostics survive a daemon restart; still mirror to the
    // daemon log for live tailing.
    let stderrFile: WriteStream | undefined
    if (opts.dataDir) {
      const logDir = path.join(opts.dataDir, 'logs', 'exthost')
      mkdirSync(logDir, { recursive: true })
      stderrFile = createWriteStream(
        path.join(logDir, `${sanitizeAuthority(opts.authority)}.log`),
        { flags: 'a' },
      )
    }

    // Child stdout is the RPC wire — pump it back to the client verbatim.
    child.stdout.on('data', (data: Buffer) => this._protocol.send(data))
    child.stderr.on('data', (data: Buffer) => {
      opts.logger.warn(`[ext-host ${opts.authority}] ${String(data).trimEnd()}`)
      stderrFile?.write(data)
    })
    child.on('error', (err) => {
      opts.logger.warn(`[remote:${opts.authority}] extension-host proc error: ${err.message}`)
    })
    child.on('exit', (code, signal) => {
      if (this._childExited || this._disposed) return
      this._childExited = true
      stderrFile?.end()
      opts.logger.info(
        `[remote:${opts.authority}] extension-host exited code=${code} signal=${signal}`,
      )
      this._sendExit(code ?? null)
      this._protocol.sendDisconnect()
      this._onConnectionClosed(this)
      this.dispose()
    })
  }

  private _sendExit(code: number | null): void {
    this._protocol.sendControl(encodeControlJson({ type: 'exit', code }))
  }

  /** Graceful stop: stdin EOF lets the host run its own shutdown, SIGKILL is the backstop. */
  private _stopChildGraceful(): void {
    if (this._childExited || !this._child || this._stoppingChild) return
    this._stoppingChild = true
    const child = this._child
    try {
      child.stdin.end()
    } catch {
      // stdin already gone
    }
    const grace = setTimeout(() => {
      if (!this._childExited) {
        this._logger.warn(
          `[remote:${this.authority}] extension-host graceful stop timed out; SIGKILL`,
        )
        try {
          child.kill('SIGKILL')
        } catch {
          // already exited
        }
      }
    }, EXT_HOST_GRACEFUL_STOP_MS)
    grace.unref?.()
  }

  override dispose(): void {
    if (this._disposed) return
    this._disposed = true
    // Graceful first: stdin EOF gives the host its own shutdown cascade; the
    // SIGKILL backstop reaps it if it overruns.
    this._stopChildGraceful()
    this._protocol.sendDisconnect()
    super.dispose()
    try {
      this._socket.dispose()
    } catch {
      // already closed
    }
  }
}
