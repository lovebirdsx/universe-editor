/**
 * Client half of the ESLint integration, running inside the extension host. Owns
 * the standalone server subprocess (spawned through Electron's own Node runtime,
 * process.execPath + ELECTRON_RUN_AS_NODE — no system node needed) and the
 * vscode-jsonrpc connection to it. Ported from the typescript plugin's LspClient
 * skeleton (spawn / env-sanitize / crash-restart), specialized to ESLint's
 * custom protocol.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { Writable } from 'node:stream'
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from 'vscode-jsonrpc/node.js'
import type { Diagnostic } from 'vscode-languageserver-types'
import {
  EslintMethods,
  type EslintCodeAction,
  type EslintLogLevel,
  type EslintSettings,
  type EslintStatus,
  type FixAllResult,
  type LogMessageParams,
  type PublishDiagnosticsParams,
  type StatusParams,
} from './protocol.js'

export interface PublishDiagnosticsEvent {
  readonly uri: string
  readonly diagnostics: readonly Diagnostic[]
}

/** Callbacks the client raises into the extension host (diagnostics, log lines
 *  for the ESLint output channel, and coarse status for a state indicator). */
export interface EslintClientHooks {
  readonly onDiagnostics: (e: PublishDiagnosticsEvent) => void
  readonly log: (level: EslintLogLevel, message: string) => void
  readonly onStatus: (status: EslintStatus, message?: string, busy?: boolean) => void
}

/** ELECTRON_* / NODE_OPTIONS stripped from the child env (same rationale as the
 *  typescript plugin): a Node-shaped child must not reinterpret its entrypoint as
 *  an Electron helper, and NODE_OPTIONS could inject --inspect / --require.
 *  ELECTRON_RUN_AS_NODE is re-added explicitly after sanitizing. */
const ENV_DENYLIST: readonly string[] = [
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_NO_ATTACH_CONSOLE',
  'ELECTRON_FORCE_IS_PACKAGED',
  'ELECTRON_DEFAULT_ERROR_MODE',
  'ELECTRON_ENABLE_LOGGING',
  'ELECTRON_ENABLE_STACK_DUMPING',
  'NODE_OPTIONS',
]

const MAX_CRASH_RESTARTS = 3
const CRASH_WINDOW_MS = 60_000

function sanitizeEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(base)) {
    if (ENV_DENYLIST.includes(k)) continue
    out[k] = v
  }
  return out
}

/** Drop writes that land after the child dies (avoids ERR_STREAM_DESTROYED). */
function guardedWritable(stdin: Writable): Writable {
  return new Writable({
    write(chunk, encoding, callback) {
      if (stdin.destroyed || !stdin.writable) {
        callback()
        return
      }
      stdin.write(chunk, encoding, callback)
    },
  })
}

interface OpenDoc {
  readonly languageId: string
  version: number
  text: string
}

export class EslintClient {
  private _proc: ChildProcessWithoutNullStreams | undefined
  private _conn: MessageConnection | undefined
  private _starting: Promise<void> | undefined
  private _disposed = false
  private readonly _restartTimestamps: number[] = []
  private readonly _open = new Map<string, OpenDoc>()

  constructor(
    private readonly _serverModule: string,
    private readonly _rootUri: string | null,
    private _settings: EslintSettings,
    private readonly _hooks: EslintClientHooks,
  ) {}

  updateSettings(settings: EslintSettings): void {
    this._settings = settings
    const conn = this._conn
    if (conn) this._notify(conn, EslintMethods.updateSettings, { settings })
  }

  async didOpen(uri: string, languageId: string, version: number, text: string): Promise<void> {
    this._open.set(uri, { languageId, version, text })
    const conn = await this._ready()
    this._notify(conn, EslintMethods.didOpen, { uri, languageId, version, text })
  }

  async didChange(uri: string, version: number, text: string): Promise<void> {
    const doc = this._open.get(uri)
    if (doc) {
      doc.version = version
      doc.text = text
    }
    const conn = await this._ready()
    this._notify(conn, EslintMethods.didChange, { uri, version, text })
  }

  async didSave(uri: string): Promise<void> {
    const conn = await this._ready()
    this._notify(conn, EslintMethods.didSave, { uri })
  }

  async didClose(uri: string): Promise<void> {
    this._open.delete(uri)
    const conn = await this._ready()
    this._notify(conn, EslintMethods.didClose, { uri })
  }

  async codeAction(
    uri: string,
    range: { start: { line: number; character: number }; end: { line: number; character: number } },
  ): Promise<EslintCodeAction[]> {
    const conn = await this._ready()
    return conn.sendRequest(EslintMethods.codeAction, { uri, range })
  }

  async fixAllEdits(uri: string): Promise<FixAllResult> {
    const conn = await this._ready()
    return conn.sendRequest(EslintMethods.fixAllEdits, { uri })
  }

  /** Kill and respawn the server (the `eslint.restart` command). */
  async restart(): Promise<void> {
    const proc = this._proc
    this._clearConnection()
    if (proc) {
      try {
        proc.stdin.end()
      } catch {
        // already gone
      }
    }
    await this._ready()
  }

  private async _ready(): Promise<MessageConnection> {
    if (!this._starting) this._starting = this._start()
    await this._starting
    if (!this._conn) throw new Error('eslint language server is not running')
    return this._conn
  }

  private async _start(): Promise<void> {
    const env = sanitizeEnv(process.env)
    env.ELECTRON_RUN_AS_NODE = '1'

    let proc: ChildProcessWithoutNullStreams
    try {
      proc = spawn(process.execPath, [this._serverModule], {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
      })
    } catch (err) {
      this._starting = undefined
      this._hooks.log(
        'error',
        `spawn failed module=${this._serverModule}: ${(err as Error).message}`,
      )
      this._hooks.onStatus('error', 'Failed to start ESLint server')
      throw err as Error
    }

    this._proc = proc
    proc.stderr.on('data', (buf: Buffer) => {
      const text = buf.toString('utf8').trimEnd()
      if (text) this._hooks.log('info', `[server] ${text}`)
    })
    proc.on('error', (e) => this._onProcGone(proc, `error ${e.message}`))
    proc.on('exit', (code, signal) => this._onProcGone(proc, `exit code=${code} signal=${signal}`))

    const conn = createMessageConnection(
      new StreamMessageReader(proc.stdout),
      new StreamMessageWriter(guardedWritable(proc.stdin)),
    )
    this._conn = conn
    conn.onNotification(EslintMethods.publishDiagnostics, (p: PublishDiagnosticsParams) => {
      this._hooks.onDiagnostics({ uri: p.uri, diagnostics: p.diagnostics ?? [] })
    })
    conn.onNotification(EslintMethods.logMessage, (p: LogMessageParams) => {
      this._hooks.log(p.level, p.message)
    })
    conn.onNotification(EslintMethods.status, (p: StatusParams) => {
      this._hooks.onStatus(p.status, p.message, p.busy)
    })
    conn.listen()

    try {
      await conn.sendRequest(EslintMethods.initialize, {
        processId: process.pid,
        rootUri: this._rootUri,
        settings: this._settings,
      })
    } catch (err) {
      if (this._proc !== proc) return
      this._hooks.log('error', `initialize failed: ${(err as Error).message}`)
      this._hooks.onStatus('error', 'ESLint server initialize failed')
      this._clearConnection()
      throw err as Error
    }

    // Replay open documents (first start: none; restart: re-prime the server).
    for (const [uri, doc] of this._open) {
      this._notify(conn, EslintMethods.didOpen, {
        uri,
        languageId: doc.languageId,
        version: doc.version,
        text: doc.text,
      })
    }
    this._hooks.log('info', `server started root=${this._rootUri ?? '(none)'}`)
  }

  private _onProcGone(proc: ChildProcessWithoutNullStreams, reason: string): void {
    if (this._proc !== proc) return
    this._clearConnection()
    if (this._disposed) return
    if (!this._registerRestartAttempt()) {
      this._hooks.log(
        'error',
        `server gone (${reason}); too many restarts, will retry on next request`,
      )
      this._hooks.onStatus('error', 'ESLint server keeps crashing')
      return
    }
    this._hooks.log('warn', `server gone (${reason}); restarting`)
    this._hooks.onStatus('warn', 'Restarting ESLint server…')
    this._starting = this._start()
    void this._starting.catch(() => undefined)
  }

  private _clearConnection(): void {
    try {
      this._conn?.dispose()
    } catch {
      // already gone
    }
    this._conn = undefined
    this._proc = undefined
    this._starting = undefined
  }

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

  private _notify(conn: MessageConnection, method: string, params: object): void {
    try {
      void conn.sendNotification(method, params).catch(() => undefined)
    } catch {
      // connection disposed mid-teardown
    }
  }

  dispose(): void {
    this._disposed = true
    const proc = this._proc
    if (proc) {
      try {
        proc.stdin.end()
      } catch {
        // already gone
      }
    }
    this._clearConnection()
  }
}
