/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Main-side host for the Markdown Language Server subprocess. Spawns the bundled
 *  server through Electron's own Node runtime (process.execPath +
 *  ELECTRON_RUN_AS_NODE) — no system node/npx required — and owns the RPC
 *  (platform ChannelClient/ChannelServer over a newline-framed stdio protocol)
 *  directly, since main IS the LSP client host. The reverse MdClient channel
 *  backs the server's IWorkspace filesystem reads via IFileService. Spawn
 *  mechanics mirror ExtensionHostMainService.
 *--------------------------------------------------------------------------------------------*/

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import * as path from 'node:path'
import { app } from 'electron'
import {
  ChannelClient,
  ChannelServer,
  createNamedLogger,
  Disposable,
  DisposableStore,
  Emitter,
  IFileService,
  ILoggerService,
  ProxyChannel,
  URI,
  type ILogger,
  type UriComponents,
} from '@universe-editor/platform'
import { StdioFramingProtocol } from '@universe-editor/extensions-common'
import {
  MdServerChannels,
  type IMdClient,
  type IMdServer,
  type MdFileType,
  type MdPosition,
} from '@universe-editor/markdown-language-server/protocol'
import type {
  IMarkdownLanguageService,
  MdDiagnostic,
  MdDocumentSymbol,
  MdLocation,
  MdWorkspaceSymbol,
} from '../../../shared/ipc/markdownLanguageService.js'

/** Spawner abstraction — injectable for tests so we don't launch real processes. */
export type MdServerSpawner = (
  command: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv },
) => ChildProcessWithoutNullStreams

/** Resolves the bundled server bootstrap entry. Injectable for tests. */
export type MdServerEntryResolver = () => string

const defaultSpawner: MdServerSpawner = (command, args, options) =>
  spawn(command, [...args], {
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    // process.execPath is a real binary whose path may contain spaces; a shell
    // wrapper would mis-quote it. Always off, like ExtensionHost/AcpHost.
    shell: false,
  })

/** Server entry under the workspace root (found by walking up from getAppPath). */
const ENTRY_DEV_REL = 'packages/markdown-language-server/dist/bootstrap.js'
/** Fallback relative to `app.getAppPath()` (apps/editor → repo root). */
const ENTRY_DEV = '../../packages/markdown-language-server/dist/bootstrap.js'
/** Server entry under `resourcesPath` in a packaged build. */
const ENTRY_PACKAGED = 'markdown-language-server/dist/bootstrap.js'

/**
 * Locate the dev bundle by walking up from `app.getAppPath()` until the
 * workspace package is found. electron-vite dev launches `electron .` (appPath =
 * apps/editor), but e2e launches `electron out/main/index.js` (appPath =
 * apps/editor/out/main); both have the repo root as an ancestor.
 */
const defaultResolveEntry: MdServerEntryResolver = () => {
  if (app.isPackaged) return path.join(process.resourcesPath, ENTRY_PACKAGED)
  let dir = app.getAppPath()
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, ENTRY_DEV_REL)
    if (existsSync(candidate)) return candidate
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return path.resolve(app.getAppPath(), ENTRY_DEV)
}

/**
 * Stripped from the child env (same rationale as ExtensionHost/AcpHost): the
 * ELECTRON_* flags would make a Node-shaped child reinterpret its entrypoint as
 * an Electron helper, and NODE_OPTIONS could inject --inspect / --require.
 * ELECTRON_RUN_AS_NODE is re-added explicitly after sanitizing.
 */
const ENV_DENYLIST: readonly string[] = [
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_NO_ATTACH_CONSOLE',
  'ELECTRON_FORCE_IS_PACKAGED',
  'ELECTRON_DEFAULT_ERROR_MODE',
  'ELECTRON_ENABLE_LOGGING',
  'ELECTRON_ENABLE_STACK_DUMPING',
  'NODE_OPTIONS',
]

/** Directories never scanned for markdown (parity with file watcher excludes). */
const SCAN_IGNORE: readonly string[] = ['node_modules', '.git', 'dist', 'out', '.turbo']
const MARKDOWN_EXT = /\.(md|markdown)$/i

/** Crash-restart backstop: at most N respawns inside a rolling window. */
const MAX_CRASH_RESTARTS = 3
const CRASH_WINDOW_MS = 60_000

const UTF8_STRICT = new TextDecoder('utf-8', { fatal: true })
const OEM_FALLBACK = makeFallbackDecoder()

function makeFallbackDecoder(): InstanceType<typeof TextDecoder> {
  try {
    return new TextDecoder('gb18030')
  } catch {
    return new TextDecoder('utf-8')
  }
}

function sanitizeEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(base)) {
    if (ENV_DENYLIST.includes(k)) continue
    out[k] = v
  }
  return out
}

export class MarkdownLanguageClientService extends Disposable implements IMarkdownLanguageService {
  declare readonly _serviceBrand: undefined

  private readonly _logger: ILogger

  /** Fired after the server is respawned (crash recovery or workspace change) so
   *  the renderer can re-push its open documents — main keeps no document text. */
  private readonly _onDidRestart = this._register(new Emitter<void>())
  readonly onDidRestart = this._onDidRestart.event

  /** Live connection (process + channels). Cleared on exit; rebuilt on next start. */
  private _proc: ChildProcessWithoutNullStreams | undefined
  private _server: IMdServer | undefined
  private _connection: DisposableStore | undefined
  /** In-flight (or resolved) start, making `ensureStarted` idempotent. */
  private _starting: Promise<void> | undefined
  /** Workspace root captured at first start; scopes the server's file scans. */
  private _workspaceRoot: string | undefined
  /** True once disposed, so a process exit doesn't trigger a crash-restart. */
  private _disposed = false
  /** Timestamps of recent crash-restarts, for the rolling-window backstop. */
  private readonly _restartTimestamps: number[] = []

  constructor(
    private readonly _spawn: MdServerSpawner = defaultSpawner,
    private readonly _resolveEntry: MdServerEntryResolver = defaultResolveEntry,
    @IFileService private readonly _files: IFileService,
    @ILoggerService loggerService?: ILoggerService,
  ) {
    super()
    this._logger = createNamedLogger(loggerService, {
      id: 'markdownLanguageServer',
      name: 'Markdown Language Server',
    })
  }

  ensureStarted(workspaceRoot?: string): Promise<void> {
    // Already running for this root (or the caller didn't specify one) — no-op.
    if (this._starting && (workspaceRoot === undefined || workspaceRoot === this._workspaceRoot)) {
      return this._starting
    }
    // Running for a different workspace — restart so the server's file scans
    // target the new root, and signal the renderer to re-push its documents.
    const isRestart = this._starting !== undefined
    if (isRestart) this._stopCurrent()
    this._workspaceRoot = workspaceRoot
    this._starting = this._start()
    if (isRestart) {
      const started = this._starting
      void started.then(() => this._onDidRestart.fire()).catch(() => undefined)
    }
    return this._starting
  }

  private _start(): Promise<void> {
    const env = sanitizeEnv(process.env)
    env.ELECTRON_RUN_AS_NODE = '1'
    if (this._workspaceRoot) env.UNIVERSE_MD_WORKSPACE_ROOT = this._workspaceRoot
    const entry = this._resolveEntry()

    let proc: ChildProcessWithoutNullStreams
    try {
      proc = this._spawn(process.execPath, [entry], { env })
    } catch (err) {
      this._starting = undefined
      this._logger.warn(`spawn failed entry=${entry}: ${(err as Error).message}`)
      return Promise.reject(err as Error)
    }

    const connection = new DisposableStore()
    this._connection = connection
    this._proc = proc

    proc.stdout.setEncoding('utf8')
    const onData = connection.add(new Emitter<string>())
    proc.stdout.on('data', (data: string) => onData.fire(data))
    proc.stderr.on('data', (buf: Buffer) => {
      this._logger.info(`[server] ${this._decodeDiag(buf)}`)
    })
    proc.on('error', (err) => {
      this._logger.warn(`proc error: ${err.message}`)
      this._onProcGone(proc, `error ${err.message}`)
    })
    proc.on('exit', (code, signal) => {
      this._logger.info(`exit code=${code} signal=${signal}`)
      this._onProcGone(proc, `exit code=${code} signal=${signal}`)
    })

    const protocol = connection.add(
      new StdioFramingProtocol({
        write: (frame) => {
          if (!proc.stdin.destroyed && proc.stdin.writable) {
            proc.stdin.write(frame, 'utf8')
          }
        },
        onData: onData.event,
      }),
    )
    const client = connection.add(new ChannelClient(protocol))
    const chServer = connection.add(new ChannelServer(protocol))
    // The server calls back here to read/scan files the renderer hasn't opened.
    chServer.registerChannel(MdServerChannels.client, ProxyChannel.fromService(this._fsBridge()))

    this._server = ProxyChannel.toService<IMdServer>(client.getChannel(MdServerChannels.server))

    this._logger.info(`start entry=${entry} root=${this._workspaceRoot ?? '(none)'}`)
    return Promise.resolve()
  }

  /** Gated filesystem the server's IWorkspace reads through (IMdClient). */
  private _fsBridge(): IMdClient {
    return {
      $readFile: async (uri) => {
        try {
          return await this._files.readFileText(URI.parse(uri))
        } catch {
          return undefined
        }
      },
      $stat: async (uri) => {
        try {
          const s = await this._files.stat(URI.parse(uri))
          const type: MdFileType = s.isDirectory ? 'dir' : 'file'
          return { type, mtime: s.mtime, size: s.size }
        } catch {
          return undefined
        }
      },
      $readDirectory: async (uri) => {
        try {
          const entries = await this._files.list(URI.parse(uri))
          return entries.map(
            (e) => [e.name, e.isDirectory ? 'dir' : 'file'] as readonly [string, MdFileType],
          )
        } catch {
          return []
        }
      },
      $findMarkdownFiles: async () => {
        if (!this._workspaceRoot) return []
        try {
          const paths = await this._files.listRecursive(URI.file(this._workspaceRoot), {
            ignore: SCAN_IGNORE,
          })
          return paths.filter((p) => MARKDOWN_EXT.test(p)).map((p) => URI.file(p).toString())
        } catch {
          return []
        }
      },
    }
  }

  /** Tear down the current connection if it belongs to `proc` (ignores stale events). */
  private _onProcGone(proc: ChildProcessWithoutNullStreams, reason: string): void {
    if (this._proc !== proc) return // stale event from an already-replaced process
    this._clearConnection()
    if (this._disposed) return
    if (!this._registerRestartAttempt()) {
      this._logger.warn(`server gone (${reason}); too many restarts, will respawn on next request`)
      return
    }
    this._logger.info(`server gone (${reason}); restarting`)
    const started = this._start()
    this._starting = started
    void started.then(() => this._onDidRestart.fire()).catch(() => undefined)
  }

  /** Drop the live connection without spawning a replacement. */
  private _clearConnection(): void {
    this._connection?.dispose()
    this._connection = undefined
    this._proc = undefined
    this._server = undefined
    this._starting = undefined
  }

  /** Kill the running server intentionally (workspace change) — no crash-restart. */
  private _stopCurrent(): void {
    const proc = this._proc
    this._clearConnection()
    if (proc) {
      try {
        proc.kill()
      } catch {
        // ignore — already gone
      }
    }
  }

  /** Rolling-window backstop against a crash loop. */
  private _registerRestartAttempt(): boolean {
    const now = Date.now()
    while (
      this._restartTimestamps.length > 0 &&
      now - (this._restartTimestamps[0] ?? 0) > CRASH_WINDOW_MS
    ) {
      this._restartTimestamps.shift()
    }
    if (this._restartTimestamps.length >= MAX_CRASH_RESTARTS) return false
    this._restartTimestamps.push(now)
    return true
  }

  private async _ready(): Promise<IMdServer> {
    await this.ensureStarted(this._workspaceRoot)
    if (!this._server) throw new Error('markdown language server is not running')
    return this._server
  }

  /** UriComponents (from the renderer over IPC) → file: URI string. */
  private _str(uri: UriComponents): string {
    return (URI.revive(uri) as URI).toString()
  }

  async didOpen(uri: UriComponents, version: number, text: string): Promise<void> {
    const server = await this._ready()
    await server.$didOpen({ uri: this._str(uri), version, text })
  }

  async didChange(uri: UriComponents, version: number, text: string): Promise<void> {
    const server = await this._ready()
    await server.$didChange({ uri: this._str(uri), version, text })
  }

  async didClose(uri: UriComponents): Promise<void> {
    const server = await this._ready()
    await server.$didClose(this._str(uri))
  }

  async provideDocumentSymbols(uri: UriComponents): Promise<readonly MdDocumentSymbol[]> {
    const server = await this._ready()
    return server.$provideDocumentSymbols(this._str(uri))
  }

  async provideDefinition(
    uri: UriComponents,
    position: MdPosition,
  ): Promise<readonly MdLocation[]> {
    const server = await this._ready()
    return server.$provideDefinition(this._str(uri), position)
  }

  async provideReferences(
    uri: UriComponents,
    position: MdPosition,
    includeDeclaration: boolean,
  ): Promise<readonly MdLocation[]> {
    const server = await this._ready()
    return server.$provideReferences(this._str(uri), position, includeDeclaration)
  }

  async provideWorkspaceSymbols(query: string): Promise<readonly MdWorkspaceSymbol[]> {
    const server = await this._ready()
    return server.$provideWorkspaceSymbols(query)
  }

  async provideDiagnostics(uri: UriComponents): Promise<readonly MdDiagnostic[]> {
    const server = await this._ready()
    return server.$computeDiagnostics(this._str(uri))
  }

  private _decodeDiag(buf: Buffer): string {
    try {
      return UTF8_STRICT.decode(buf)
    } catch {
      return OEM_FALLBACK.decode(buf)
    }
  }

  override dispose(): void {
    this._disposed = true
    if (this._proc) {
      try {
        this._proc.kill()
      } catch {
        // ignore — shutting down
      }
    }
    this._connection?.dispose()
    this._connection = undefined
    this._proc = undefined
    this._server = undefined
    super.dispose()
  }
}
