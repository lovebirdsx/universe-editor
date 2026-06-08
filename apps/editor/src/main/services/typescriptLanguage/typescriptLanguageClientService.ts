/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Universe Editor Authors. All rights reserved.
 *  Main-side host for the TS/JS language server subprocess. Spawns the vendored
 *  `typescript-language-server` (which drives TypeScript's bundled tsserver)
 *  through Electron's own Node runtime (process.execPath + ELECTRON_RUN_AS_NODE)
 *  — no system node/npx required — and owns the standard-LSP connection
 *  (vscode-jsonrpc over stdio) directly, since main IS the LSP client host.
 *
 *  Forked from MarkdownLanguageClientService: identical spawn / env-sanitize /
 *  crash-restart / workspace-switch skeleton, with the project-private RPC layer
 *  swapped for standard LSP. Two structural differences:
 *   - an extra `initialize` handshake gate (`_start` resolves only once the
 *     server has answered `initialize` and we've sent `initialized`);
 *   - diagnostics are PUSH (server-initiated `publishDiagnostics`), re-fired to
 *     the renderer via onDidPublishDiagnostics.
 *  No reverse fs bridge is needed — tsserver reads the real filesystem directly.
 *--------------------------------------------------------------------------------------------*/

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import * as path from 'node:path'
import { app } from 'electron'
import {
  createNamedLogger,
  Disposable,
  DisposableStore,
  Emitter,
  ILoggerService,
  URI,
  type ILogger,
  type UriComponents,
} from '@universe-editor/platform'
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from 'vscode-jsonrpc/node.js'
import type {
  CompletionItem,
  CompletionList,
  Definition,
  DefinitionLink,
  Diagnostic,
  DocumentSymbol,
  Hover,
  ITypescriptLanguageService,
  Location,
  Position,
  SignatureHelp,
  SymbolInformation,
  TsCompletionContext,
  TsPublishDiagnosticsEvent,
  TsSignatureHelpContext,
  WorkspaceEdit,
  WorkspaceSymbol,
} from '../../../shared/ipc/typescriptLanguageService.js'

/** Spawner abstraction — injectable for tests so we don't launch real processes. */
export type TsServerSpawner = (
  command: string,
  args: readonly string[],
  options: { env?: NodeJS.ProcessEnv },
) => ChildProcessWithoutNullStreams

/** Resolves the vendored CLI entry + bundled tsserver path. Injectable for tests. */
export type TsServerEntryResolver = () => { cli: string; tsserver: string }

const defaultSpawner: TsServerSpawner = (command, args, options) =>
  spawn(command, [...args], {
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    // process.execPath is a real binary whose path may contain spaces; a shell
    // wrapper would mis-quote it. Always off, like ExtensionHost/AcpHost.
    shell: false,
  })

/** CLI under the vendor dir, found by walking up from getAppPath in dev. */
const CLI_VENDOR_REL =
  'vendor/typescript-language-server/node_modules/typescript-language-server/lib/cli.mjs'
/** CLI relative to `process.resourcesPath` in a packaged build. */
const CLI_PACKAGED_REL =
  'typescript-language-server/node_modules/typescript-language-server/lib/cli.mjs'

/** tsserver.js sits beside the CLI's node_modules (…/node_modules/typescript/lib/tsserver.js). */
function tsserverFor(cli: string): string {
  return path.resolve(path.dirname(cli), '../../typescript/lib/tsserver.js')
}

/**
 * Locate the vendored CLI by walking up from `app.getAppPath()` (dev) or under
 * `process.resourcesPath` (packaged). Mirrors the markdown server's resolver;
 * the dev walk-up tolerates both `electron .` (appPath = apps/editor) and the
 * e2e `electron out/main/index.js` layout.
 */
const defaultResolveEntry: TsServerEntryResolver = () => {
  if (app.isPackaged) {
    const cli = path.join(process.resourcesPath, CLI_PACKAGED_REL)
    return { cli, tsserver: tsserverFor(cli) }
  }
  let dir = app.getAppPath()
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, CLI_VENDOR_REL)
    if (existsSync(candidate)) return { cli: candidate, tsserver: tsserverFor(candidate) }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  const cli = path.resolve(app.getAppPath(), '../..', CLI_VENDOR_REL)
  return { cli, tsserver: tsserverFor(cli) }
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

export class TypescriptLanguageClientService
  extends Disposable
  implements ITypescriptLanguageService
{
  declare readonly _serviceBrand: undefined

  private readonly _logger: ILogger

  private readonly _onDidRestart = this._register(new Emitter<void>())
  readonly onDidRestart = this._onDidRestart.event

  private readonly _onDidPublishDiagnostics = this._register(
    new Emitter<TsPublishDiagnosticsEvent>(),
  )
  readonly onDidPublishDiagnostics = this._onDidPublishDiagnostics.event

  /** Live connection (process + jsonrpc). Cleared on exit; rebuilt on next start. */
  private _proc: ChildProcessWithoutNullStreams | undefined
  private _conn: MessageConnection | undefined
  private _connStore: DisposableStore | undefined
  /** In-flight (or resolved) start, making `ensureStarted` idempotent. Resolves
   *  only after the LSP `initialize` handshake completes. */
  private _starting: Promise<void> | undefined
  /** Workspace root captured at first start; scopes the server's project search. */
  private _workspaceRoot: string | undefined
  private _disposed = false
  private readonly _restartTimestamps: number[] = []

  constructor(
    private readonly _spawn: TsServerSpawner = defaultSpawner,
    private readonly _resolveEntry: TsServerEntryResolver = defaultResolveEntry,
    @ILoggerService loggerService?: ILoggerService,
  ) {
    super()
    this._logger = createNamedLogger(loggerService, {
      id: 'typescriptLanguageServer',
      name: 'TS/JS Language Server',
    })
  }

  ensureStarted(workspaceRoot?: string): Promise<void> {
    if (this._starting && (workspaceRoot === undefined || workspaceRoot === this._workspaceRoot)) {
      return this._starting
    }
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

  private async _start(): Promise<void> {
    const env = sanitizeEnv(process.env)
    env.ELECTRON_RUN_AS_NODE = '1'
    const { cli, tsserver } = this._resolveEntry()

    let proc: ChildProcessWithoutNullStreams
    try {
      proc = this._spawn(process.execPath, [cli, '--stdio'], { env })
    } catch (err) {
      this._starting = undefined
      this._logger.warn(`spawn failed cli=${cli}: ${(err as Error).message}`)
      throw err as Error
    }

    const store = new DisposableStore()
    this._connStore = store
    this._proc = proc

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

    const conn = createMessageConnection(
      new StreamMessageReader(proc.stdout),
      new StreamMessageWriter(proc.stdin),
    )
    store.add({ dispose: () => conn.dispose() })
    this._conn = conn

    conn.onNotification('textDocument/publishDiagnostics', (params: PublishDiagnosticsParams) => {
      this._onDidPublishDiagnostics.fire({
        uri: URI.parse(params.uri),
        ...(params.version !== undefined ? { version: params.version } : {}),
        diagnostics: params.diagnostics ?? [],
      })
    })
    conn.listen()

    try {
      await conn.sendRequest('initialize', this._initializeParams(tsserver))
      conn.sendNotification('initialized', {})
    } catch (err) {
      this._logger.warn(`initialize failed: ${(err as Error).message}`)
      this._clearConnection()
      throw err as Error
    }

    this._logger.info(`start cli=${cli} root=${this._workspaceRoot ?? '(none)'}`)
  }

  private _initializeParams(tsserverPath: string): InitializeParams {
    const root = this._workspaceRoot
    const rootUri = root ? URI.file(root).toString() : null
    return {
      processId: process.pid,
      rootUri,
      workspaceFolders: root ? [{ uri: rootUri as string, name: path.basename(root) }] : null,
      initializationOptions: {
        // Point the server at OUR bundled tsserver, never a project-local or
        // global TypeScript. The vendor dir ships exactly the version we pinned.
        tsserver: { path: tsserverPath },
      },
      capabilities: {
        textDocument: {
          synchronization: { dynamicRegistration: false },
          completion: {
            completionItem: {
              snippetSupport: true,
              insertReplaceSupport: true,
              resolveSupport: { properties: ['documentation', 'detail', 'additionalTextEdits'] },
            },
            completionItemKind: {},
            contextSupport: true,
          },
          hover: { contentFormat: ['markdown', 'plaintext'] },
          signatureHelp: {
            signatureInformation: {
              documentationFormat: ['markdown', 'plaintext'],
              parameterInformation: { labelOffsetSupport: true },
            },
          },
          definition: { linkSupport: true },
          references: {},
          implementation: { linkSupport: true },
          typeDefinition: { linkSupport: true },
          documentSymbol: { hierarchicalDocumentSymbolSupport: true },
          rename: { prepareSupport: true },
          publishDiagnostics: { relatedInformation: true, versionSupport: true },
        },
        workspace: {
          workspaceFolders: true,
          symbol: {},
        },
      },
    }
  }

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

  private _clearConnection(): void {
    this._connStore?.dispose()
    this._connStore = undefined
    this._conn = undefined
    this._proc = undefined
    this._starting = undefined
  }

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

  private async _ready(): Promise<MessageConnection> {
    await this.ensureStarted(this._workspaceRoot)
    if (!this._conn) throw new Error('typescript language server is not running')
    return this._conn
  }

  /** UriComponents (from the renderer over IPC) → file: URI string. */
  private _str(uri: UriComponents): string {
    return (URI.revive(uri) as URI).toString()
  }

  private _doc(uri: UriComponents): { textDocument: { uri: string } } {
    return { textDocument: { uri: this._str(uri) } }
  }

  async didOpen(
    uri: UriComponents,
    languageId: string,
    version: number,
    text: string,
  ): Promise<void> {
    const conn = await this._ready()
    conn.sendNotification('textDocument/didOpen', {
      textDocument: { uri: this._str(uri), languageId, version, text },
    })
  }

  async didChange(uri: UriComponents, version: number, text: string): Promise<void> {
    const conn = await this._ready()
    conn.sendNotification('textDocument/didChange', {
      textDocument: { uri: this._str(uri), version },
      contentChanges: [{ text }],
    })
  }

  async didClose(uri: UriComponents): Promise<void> {
    const conn = await this._ready()
    conn.sendNotification('textDocument/didClose', this._doc(uri))
  }

  async provideDefinition(
    uri: UriComponents,
    position: Position,
  ): Promise<Definition | DefinitionLink[] | null> {
    const conn = await this._ready()
    return conn.sendRequest('textDocument/definition', { ...this._doc(uri), position })
  }

  async provideReferences(
    uri: UriComponents,
    position: Position,
    includeDeclaration: boolean,
  ): Promise<Location[] | null> {
    const conn = await this._ready()
    return conn.sendRequest('textDocument/references', {
      ...this._doc(uri),
      position,
      context: { includeDeclaration },
    })
  }

  async provideImplementation(
    uri: UriComponents,
    position: Position,
  ): Promise<Definition | DefinitionLink[] | null> {
    const conn = await this._ready()
    return conn.sendRequest('textDocument/implementation', { ...this._doc(uri), position })
  }

  async provideTypeDefinition(
    uri: UriComponents,
    position: Position,
  ): Promise<Definition | DefinitionLink[] | null> {
    const conn = await this._ready()
    return conn.sendRequest('textDocument/typeDefinition', { ...this._doc(uri), position })
  }

  async provideHover(uri: UriComponents, position: Position): Promise<Hover | null> {
    const conn = await this._ready()
    return conn.sendRequest('textDocument/hover', { ...this._doc(uri), position })
  }

  async provideCompletion(
    uri: UriComponents,
    position: Position,
    context: TsCompletionContext,
  ): Promise<CompletionItem[] | CompletionList | null> {
    const conn = await this._ready()
    return conn.sendRequest('textDocument/completion', { ...this._doc(uri), position, context })
  }

  async resolveCompletion(item: CompletionItem): Promise<CompletionItem> {
    const conn = await this._ready()
    return conn.sendRequest('completionItem/resolve', item)
  }

  async provideSignatureHelp(
    uri: UriComponents,
    position: Position,
    context: TsSignatureHelpContext,
  ): Promise<SignatureHelp | null> {
    const conn = await this._ready()
    return conn.sendRequest('textDocument/signatureHelp', { ...this._doc(uri), position, context })
  }

  async provideDocumentSymbols(
    uri: UriComponents,
  ): Promise<DocumentSymbol[] | SymbolInformation[] | null> {
    const conn = await this._ready()
    return conn.sendRequest('textDocument/documentSymbol', this._doc(uri))
  }

  async provideWorkspaceSymbols(
    query: string,
  ): Promise<WorkspaceSymbol[] | SymbolInformation[] | null> {
    const conn = await this._ready()
    return conn.sendRequest('workspace/symbol', { query })
  }

  async provideRenameEdits(
    uri: UriComponents,
    position: Position,
    newName: string,
  ): Promise<WorkspaceEdit | null> {
    const conn = await this._ready()
    return conn.sendRequest('textDocument/rename', { ...this._doc(uri), position, newName })
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
    this._connStore?.dispose()
    this._connStore = undefined
    this._conn = undefined
    this._proc = undefined
    super.dispose()
  }
}

/** LSP `initialize` params we actually populate (loosely typed — sent verbatim). */
interface InitializeParams {
  processId: number
  rootUri: string | null
  workspaceFolders: { uri: string; name: string }[] | null
  initializationOptions: { tsserver: { path: string } }
  capabilities: Record<string, unknown>
}

/** Subset of LSP `PublishDiagnosticsParams` we read. */
interface PublishDiagnosticsParams {
  uri: string
  version?: number
  diagnostics?: Diagnostic[]
}
