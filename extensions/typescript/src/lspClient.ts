/**
 * In-process LSP client for the TypeScript plugin. Spawns the vendored
 * `typescript-language-server` (which drives TypeScript's bundled tsserver)
 * through Electron's own Node runtime (process.execPath + ELECTRON_RUN_AS_NODE)
 * and owns the standard-LSP connection (vscode-jsonrpc over stdio).
 *
 * Ported from the former main-process TypescriptLanguageClientService: same
 * spawn / env-sanitize / initialize-handshake / crash-restart skeleton, minus
 * the Electron/platform coupling. CLI + tsserver paths are injected by the main
 * process via UNIVERSE_TSLS_CLI / UNIVERSE_TSLS_TSSERVER (the only Electron-aware
 * resolution stays in main). Diagnostics are server PUSH, surfaced via onDiagnostics.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { basename } from 'node:path'
import { Writable } from 'node:stream'
import {
  Emitter,
  CancellationTokenSource as RpcCancellationTokenSource,
  type Event,
} from 'vscode-jsonrpc'
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from 'vscode-jsonrpc/node.js'
import { URI } from 'vscode-uri'
import type { CancellationToken } from '@universe-editor/extension-api'
import type {
  CodeLens,
  CompletionItem,
  CompletionList,
  Definition,
  DefinitionLink,
  Diagnostic,
  DocumentSymbol,
  Hover,
  Location,
  Position,
  SemanticTokens,
  SignatureHelp,
  SymbolInformation,
  WorkspaceEdit,
  WorkspaceSymbol,
} from 'vscode-languageserver-types'

export interface PublishDiagnosticsEvent {
  readonly uri: string
  readonly version?: number
  readonly diagnostics: readonly Diagnostic[]
}

/**
 * Lifecycle state of the language server, surfaced so the UI can tell the user
 * it is coming up. `starting` covers the spawn + `initialize` handshake window
 * (during which every language request blocks in `_ready()`); `ready` once the
 * handshake completes; `error` when the server can't be started.
 */
export type LspServerState = 'starting' | 'ready' | 'error'

/** Mirrors LSP `CompletionContext` (triggerKind 1 = invoked, 2 = char, 3 = re-trigger). */
export interface CompletionContext {
  readonly triggerKind: 1 | 2 | 3
  readonly triggerCharacter?: string
}

/** Mirrors LSP `SignatureHelpContext`. */
export interface SignatureHelpContext {
  readonly triggerKind: 1 | 2 | 3
  readonly triggerCharacter?: string
  readonly isRetrigger: boolean
}

/**
 * Stripped from the child env (same rationale as the host/AcpHost): the
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

/** After the `initialize` handshake, how long to wait for tsserver to begin
 *  loading a project before declaring the server ready anyway. Covers workspaces
 *  with no TS/JS project (nothing ever loads) without hanging the spinner. */
const READY_GRACE_MS = 2_000

/** tsserver's project-load progress carries this title (matches VSCode). We only
 *  treat progress whose title starts with this as "loading a project"; other
 *  workDoneProgress (e.g. go-to-source-definition) must not gate readiness. */
const PROJECT_LOADING_TITLE = 'Initializing'

/** Workspace-symbol cap (VSCode's TS extension passes maxResultLimit 256 to
 *  navto; TSLS doesn't, so we slice the relevance-sorted result ourselves). */
const MAX_WORKSPACE_SYMBOLS = 256

function sanitizeEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(base)) {
    if (ENV_DENYLIST.includes(k)) continue
    out[k] = v
  }
  return out
}

/**
 * Wraps the child's stdin so jsonrpc writes that land after the process has died
 * are dropped instead of throwing ERR_STREAM_DESTROYED (jsonrpc's internal
 * $/cancelRequest, responses).
 */
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

export class LspClient {
  private _proc: ChildProcessWithoutNullStreams | undefined
  private _conn: MessageConnection | undefined
  /** In-flight (or resolved) start, making `_ready` idempotent. Resolves only
   *  after the LSP `initialize` handshake completes. */
  private _starting: Promise<void> | undefined
  private _disposed = false
  private readonly _restartTimestamps: number[] = []
  /** Open documents we've forwarded, replayed on crash restart. */
  private readonly _open = new Map<string, OpenDoc>()
  /** Seed documents pinned open to keep workspace projects loaded (prewarm).
   *  A monorepo needs one seed per tsconfig, since tsserver's navto only searches
   *  the project owning an open file. A user `didClose` of a pinned uri is ignored
   *  so its project stays resident. */
  private readonly _pinnedUris = new Set<string>()

  /** Semantic-tokens legend the server announces in its `initialize` response.
   *  Undefined until the handshake completes (or if the server omits it). */
  private _semanticTokensLegend: SemanticTokensLegend | undefined

  private readonly _onDiagnostics: (e: PublishDiagnosticsEvent) => void
  /** Called when the server asks the client to refresh CodeLenses
   *  (`workspace/codeLens/refresh`), e.g. after project graph changes. */
  private _onCodeLensRefresh: (() => void) | undefined

  /** Current lifecycle state, fed to `onDidChangeState`. Starts `starting` since
   *  construction is immediately followed by a prewarm/first request that spawns. */
  private _state: LspServerState = 'starting'
  private readonly _onDidChangeState = new Emitter<LspServerState>()
  /** Fires whenever the server's lifecycle state changes (starting/ready/error). */
  readonly onDidChangeState: Event<LspServerState> = this._onDidChangeState.event

  /** In-flight project-load progress tokens (from `window/workDoneProgress`, title
   *  "Initializing JS/TS…"). Non-empty ⇒ tsserver is still building a program, so
   *  semantic tokens / CodeLens aren't accurate yet. This — not the near-instant
   *  `initialize` handshake — is what "ready" tracks. */
  private readonly _loadingTokens = new Set<ProgressToken>()
  /** After the handshake, wait briefly for a project load to start. If none does
   *  (a workspace with no TS project, or a pure-JS folder), settle to `ready` so
   *  the spinner doesn't hang forever. Cleared once a load begins. */
  private _readyGraceTimer: ReturnType<typeof setTimeout> | undefined
  /** True between a successful handshake and the moment we've resolved readiness
   *  (either a project finished loading, or the grace window elapsed with none). */
  private _awaitingProjectLoad = false

  constructor(
    private readonly _cli: string,
    private readonly _tsserver: string,
    private readonly _workspaceRoot: string | undefined,
    onDiagnostics: (e: PublishDiagnosticsEvent) => void,
  ) {
    this._onDiagnostics = onDiagnostics
  }

  /** Register the CodeLens refresh listener (the plugin bridges it to the
   *  provider's `onDidChangeCodeLenses`). */
  onCodeLensRefresh(listener: () => void): void {
    this._onCodeLensRefresh = listener
  }

  /** The server's current lifecycle state. */
  get state(): LspServerState {
    return this._state
  }

  private _setState(state: LspServerState): void {
    if (this._state === state) return
    this._state = state
    this._onDidChangeState.fire(state)
  }

  // --- prewarm -------------------------------------------------------------

  /** Spawn tsserver and complete the `initialize` handshake ahead of the first
   *  language request. Idempotent (shares `_ready`), so a later real request
   *  reuses the already-warm connection instead of paying the cold start. */
  async ensureReady(): Promise<void> {
    await this._ready()
  }

  /**
   * Pin a seed document open to force tsserver to load a workspace project.
   * tsserver creates projects lazily — until at least one TS/JS file is open it
   * throws "No Project" for navto (workspace/symbol), so prewarming the process
   * alone isn't enough to make workspace symbols available before the user opens
   * a file. In a monorepo navto only searches the project owning an open file, so
   * one seed is pinned per tsconfig we want covered. Pinned documents stay open
   * for the client's lifetime (a user `didClose` of the same uri is ignored, see
   * `didClose`) and are replayed on crash restart via `_open`. Idempotent per uri.
   */
  async pinProject(uri: string, languageId: string, text: string): Promise<void> {
    if (this._pinnedUris.has(uri)) return
    this._pinnedUris.add(uri)
    await this.didOpen(uri, languageId, 1, text)
  }

  // --- document sync -------------------------------------------------------

  async didOpen(uri: string, languageId: string, version: number, text: string): Promise<void> {
    this._open.set(uri, { languageId, version, text })
    const conn = await this._ready()
    this._notify(conn, 'textDocument/didOpen', {
      textDocument: { uri, languageId, version, text },
    })
  }

  async didChange(uri: string, version: number, text: string): Promise<void> {
    const doc = this._open.get(uri)
    if (doc) {
      doc.version = version
      doc.text = text
    }
    const conn = await this._ready()
    this._notify(conn, 'textDocument/didChange', {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    })
  }

  async didClose(uri: string): Promise<void> {
    // Keep the prewarm pins open: closing one would unload its project (tsserver
    // drops a project the moment its last file closes), undoing the prewarm.
    if (this._pinnedUris.has(uri)) return
    this._open.delete(uri)
    const conn = await this._ready()
    this._notify(conn, 'textDocument/didClose', { textDocument: { uri } })
  }

  // --- language requests ---------------------------------------------------

  async provideDefinition(
    uri: string,
    position: Position,
  ): Promise<Definition | DefinitionLink[] | null> {
    const conn = await this._ready()
    return conn.sendRequest('textDocument/definition', { ...this._doc(uri), position })
  }

  async provideReferences(
    uri: string,
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
    uri: string,
    position: Position,
  ): Promise<Definition | DefinitionLink[] | null> {
    const conn = await this._ready()
    return conn.sendRequest('textDocument/implementation', { ...this._doc(uri), position })
  }

  async provideTypeDefinition(
    uri: string,
    position: Position,
  ): Promise<Definition | DefinitionLink[] | null> {
    const conn = await this._ready()
    return conn.sendRequest('textDocument/typeDefinition', { ...this._doc(uri), position })
  }

  async provideHover(uri: string, position: Position): Promise<Hover | null> {
    const conn = await this._ready()
    return conn.sendRequest('textDocument/hover', { ...this._doc(uri), position })
  }

  async provideCompletion(
    uri: string,
    position: Position,
    context: CompletionContext,
  ): Promise<CompletionItem[] | CompletionList | null> {
    const conn = await this._ready()
    return conn.sendRequest('textDocument/completion', { ...this._doc(uri), position, context })
  }

  async resolveCompletion(item: CompletionItem): Promise<CompletionItem> {
    const conn = await this._ready()
    return conn.sendRequest('completionItem/resolve', item)
  }

  async provideSignatureHelp(
    uri: string,
    position: Position,
    context: SignatureHelpContext,
  ): Promise<SignatureHelp | null> {
    const conn = await this._ready()
    return conn.sendRequest('textDocument/signatureHelp', { ...this._doc(uri), position, context })
  }

  async provideDocumentSymbols(
    uri: string,
  ): Promise<DocumentSymbol[] | SymbolInformation[] | null> {
    const conn = await this._ready()
    return conn.sendRequest('textDocument/documentSymbol', this._doc(uri))
  }

  async provideWorkspaceSymbols(
    query: string,
    token?: CancellationToken,
  ): Promise<WorkspaceSymbol[] | SymbolInformation[] | null> {
    // An empty query is a match-all: on a large project navto returns tens of
    // thousands of symbols (TSLS passes no maxResultLimit, so tsserver doesn't
    // cap either) and stalls the serialized request queue for seconds. VSCode's
    // TS extension returns no results for it; callers must not send it.
    if (!query) return []
    const conn = await this._ready()
    // Bridge the API token to jsonrpc's so cancellation reaches the server
    // ($/cancelRequest → TSLS cancellation pipe → tsserver aborts the navto).
    const cts = new RpcCancellationTokenSource()
    const sub = token?.onCancellationRequested(() => cts.cancel())
    try {
      const result = await conn.sendRequest<WorkspaceSymbol[] | SymbolInformation[] | null>(
        'workspace/symbol',
        { query },
        cts.token,
      )
      // navto is unbounded; keep the relevance-sorted head (VSCode caps at 256)
      // so a broad query can't move a huge payload across both IPC hops.
      return Array.isArray(result) && result.length > MAX_WORKSPACE_SYMBOLS
        ? result.slice(0, MAX_WORKSPACE_SYMBOLS)
        : result
    } catch (err) {
      if (cts.token.isCancellationRequested) return null
      const message = (err as Error).message
      // "No Project" is expected, not a failure: tsserver creates projects
      // lazily, so navto has nothing to search until a TS/JS file has been
      // opened (or a tsconfig/jsconfig exists). Degrade silently to no results;
      // only surface genuinely unexpected failures.
      if (!/No Project/i.test(message)) {
        console.error(`[typescript] workspace/symbol failed: ${message}`)
      }
      return null
    } finally {
      sub?.dispose()
      cts.dispose()
    }
  }

  async provideRenameEdits(
    uri: string,
    position: Position,
    newName: string,
  ): Promise<WorkspaceEdit | null> {
    const conn = await this._ready()
    return conn.sendRequest('textDocument/rename', { ...this._doc(uri), position, newName })
  }

  /** The server's semantic-tokens legend, captured from the `initialize` response.
   *  Waits for the handshake so callers registering the Monaco provider get the
   *  real legend (its index → name mapping decodes `SemanticTokens.data`). */
  async getSemanticTokensLegend(): Promise<SemanticTokensLegend | undefined> {
    await this._ready()
    return this._semanticTokensLegend
  }

  async provideDocumentSemanticTokens(uri: string): Promise<SemanticTokens | null> {
    const conn = await this._ready()
    return conn.sendRequest('textDocument/semanticTokens/full', this._doc(uri))
  }

  async provideCodeLenses(uri: string): Promise<CodeLens[] | null> {
    const conn = await this._ready()
    return conn.sendRequest('textDocument/codeLens', this._doc(uri))
  }

  async resolveCodeLens(lens: CodeLens): Promise<CodeLens | null> {
    const conn = await this._ready()
    return conn.sendRequest('codeLens/resolve', lens)
  }

  // --- lifecycle -----------------------------------------------------------

  private _doc(uri: string): { textDocument: { uri: string } } {
    return { textDocument: { uri } }
  }

  private async _ready(): Promise<MessageConnection> {
    if (!this._starting) this._starting = this._start()
    await this._starting
    if (!this._conn) throw new Error('typescript language server is not running')
    return this._conn
  }

  private async _start(): Promise<void> {
    this._setState('starting')
    const env = sanitizeEnv(process.env)
    env.ELECTRON_RUN_AS_NODE = '1'

    let proc: ChildProcessWithoutNullStreams
    try {
      proc = spawn(process.execPath, [this._cli, '--stdio'], {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
      })
    } catch (err) {
      this._starting = undefined
      this._setState('error')
      console.error(`[typescript] spawn failed cli=${this._cli}: ${(err as Error).message}`)
      throw err as Error
    }

    this._proc = proc

    proc.stderr.on('data', (buf: Buffer) => {
      console.error(`[typescript][server] ${buf.toString('utf8')}`)
    })
    proc.on('error', (err) => this._onProcGone(proc, `error ${err.message}`))
    proc.on('exit', (code, signal) => this._onProcGone(proc, `exit code=${code} signal=${signal}`))

    const conn = createMessageConnection(
      new StreamMessageReader(proc.stdout),
      new StreamMessageWriter(guardedWritable(proc.stdin)),
    )
    this._conn = conn

    conn.onNotification('textDocument/publishDiagnostics', (params: PublishDiagnosticsParams) => {
      this._onDiagnostics({
        uri: params.uri,
        ...(params.version !== undefined ? { version: params.version } : {}),
        diagnostics: params.diagnostics ?? [],
      })
    })
    // Server → client: "re-request CodeLenses". We ack with null and bridge the
    // signal to the plugin, which fires the provider's onDidChangeCodeLenses.
    conn.onRequest('workspace/codeLens/refresh', () => {
      this._onCodeLensRefresh?.()
      return null
    })
    // Server → client: create a progress token. tsserver uses this for project
    // loading ("Initializing JS/TS language features…"); we ack so the server
    // then streams `$/progress` begin/end for it. Requires
    // capabilities.window.workDoneProgress in `initialize` (below), else tsserver
    // silently drops all project-load progress.
    conn.onRequest('window/workDoneProgress/create', () => null)
    conn.onNotification('$/progress', (params: ProgressParams) => {
      this._onProgress(params)
    })
    conn.listen()

    try {
      const result = (await conn.sendRequest('initialize', this._initializeParams())) as
        | InitializeResult
        | undefined
      this._semanticTokensLegend = result?.capabilities?.semanticTokensProvider?.legend
      this._notify(conn, 'initialized', {})
      // Enable references CodeLens (off by default in tsserver). implementations
      // stays off to match VSCode's default and keep the gutter quiet.
      this._notify(conn, 'workspace/didChangeConfiguration', {
        settings: {
          typescript: { referencesCodeLens: { enabled: true, showOnAllFunctions: false } },
          javascript: { referencesCodeLens: { enabled: true, showOnAllFunctions: false } },
        },
      })
    } catch (err) {
      if (this._proc !== proc) return // superseded by a concurrent restart
      this._setState('error')
      console.error(`[typescript] initialize failed: ${(err as Error).message}`)
      this._clearConnection()
      throw err as Error
    }

    // Replay open documents (first start: none; restart: re-prime the server).
    for (const [uri, doc] of this._open) {
      this._notify(conn, 'textDocument/didOpen', {
        textDocument: { uri, languageId: doc.languageId, version: doc.version, text: doc.text },
      })
    }
    // The handshake is near-instant, but semantic tokens / CodeLens only become
    // accurate once tsserver finishes loading the project — reported via
    // `$/progress`. Stay `starting` and wait for that (see `_onProgress`); if no
    // load begins within the grace window (no TS project in this workspace),
    // settle to `ready` anyway.
    this._awaitingProjectLoad = true
    this._armReadyGrace()
    console.error(`[typescript] server started root=${this._workspaceRoot ?? '(none)'}`)
  }

  /** Handle `$/progress`: track project-load progress to drive the ready state. */
  private _onProgress(params: ProgressParams): void {
    const value = params.value
    if (value.kind === 'begin') {
      if (!value.title || !value.title.startsWith(PROJECT_LOADING_TITLE)) return
      this._clearReadyGrace()
      this._awaitingProjectLoad = false
      this._loadingTokens.add(params.token)
      this._setState('starting')
    } else if (value.kind === 'end') {
      if (!this._loadingTokens.delete(params.token)) return
      if (this._loadingTokens.size === 0) this._setState('ready')
    }
  }

  /** Start (or restart) the post-handshake grace timer: if no project load has
   *  begun when it fires, declare the server ready. */
  private _armReadyGrace(): void {
    this._clearReadyGrace()
    this._readyGraceTimer = setTimeout(() => {
      this._readyGraceTimer = undefined
      // Only settle if we're still just waiting for a load that never came.
      if (this._awaitingProjectLoad && this._loadingTokens.size === 0) {
        this._awaitingProjectLoad = false
        this._setState('ready')
      }
    }, READY_GRACE_MS)
  }

  private _clearReadyGrace(): void {
    if (this._readyGraceTimer !== undefined) {
      clearTimeout(this._readyGraceTimer)
      this._readyGraceTimer = undefined
    }
  }

  private _initializeParams(): InitializeParams {
    const root = this._workspaceRoot
    const rootUri = root ? URI.file(root).toString() : null
    return {
      processId: process.pid,
      rootUri,
      workspaceFolders: root ? [{ uri: rootUri as string, name: basename(root) }] : null,
      initializationOptions: {
        // Point the server at OUR bundled tsserver, never a project-local or
        // global TypeScript. The vendor dir ships exactly the version we pinned.
        tsserver: { path: this._tsserver },
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
          codeLens: {},
          semanticTokens: {
            // We only use whole-document tokens; the server still advertises its
            // legend in the initialize response, which we read to decode `data`.
            requests: { full: true, range: false },
            formats: ['relative'],
            tokenTypes: [],
            tokenModifiers: [],
          },
        },
        workspace: {
          workspaceFolders: true,
          symbol: {},
          // Lets the server ask us to re-request CodeLenses (workspace/codeLens/refresh).
          codeLens: { refreshSupport: true },
        },
        window: {
          // Opt into server-initiated progress. tsserver gates its project-load
          // progress ("Initializing JS/TS language features…") on this — without
          // it, `createWorkDoneProgress` returns a null reporter and no
          // begin/end `$/progress` is ever sent, so we can't tell when the
          // project (and thus semantic tokens / CodeLens) is actually ready.
          workDoneProgress: true,
        },
      },
    }
  }

  private _onProcGone(proc: ChildProcessWithoutNullStreams, reason: string): void {
    if (this._proc !== proc) return // stale event from an already-replaced process
    this._clearConnection()
    if (this._disposed) return
    if (!this._registerRestartAttempt()) {
      this._setState('error')
      console.error(
        `[typescript] server gone (${reason}); too many restarts, will retry on next request`,
      )
      return
    }
    console.error(`[typescript] server gone (${reason}); restarting`)
    this._starting = this._start()
    void this._starting.catch(() => undefined)
  }

  private _clearConnection(): void {
    try {
      this._conn?.dispose()
    } catch {
      // ignore — already gone
    }
    this._conn = undefined
    this._proc = undefined
    this._starting = undefined
    // Drop any project-load tracking: a restart re-primes from scratch, and a
    // stale token would wedge the state (its `end` will never arrive).
    this._clearReadyGrace()
    this._loadingTokens.clear()
    this._awaitingProjectLoad = false
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

  /** Fire-and-forget LSP notification; must never surface as an unhandled rejection. */
  private _notify(conn: MessageConnection, method: string, params: object): void {
    try {
      void conn.sendNotification(method, params).catch(() => undefined)
    } catch {
      // connection disposed mid-teardown
    }
  }

  dispose(): void {
    this._disposed = true
    this._onDidChangeState.dispose()
    const proc = this._proc
    if (proc) {
      // The spawned CLI (`typescript-language-server`) forks tsserver as its own
      // children (a syntax + a semantic server) and reaps them from its
      // `process.on('exit')` hook. A hard kill (`taskkill /F` / TerminateProcess)
      // skips that hook, orphaning the tsserver grandchildren — they survive app
      // quit holding pipes open, blocking Playwright teardown and leaking stray
      // electron.exe for real users. Closing the CLI's stdin lets it observe EOF
      // and exit gracefully, running its hook so tsserver dies with it. The CLI
      // exits on its own even after we return, so no wait is needed on the
      // synchronous shutdown path.
      try {
        proc.stdin.end()
      } catch {
        // Already gone — connection teardown below is still safe.
      }
    }
    this._clearConnection()
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

/** LSP progress token (opaque, numeric or string). */
type ProgressToken = number | string

/** LSP `$/progress` notification carrying a `WorkDoneProgress` value. We only act
 *  on `begin` (with a title) and `end`; `report` is ignored. */
interface ProgressParams {
  token: ProgressToken
  value: { kind: 'begin' | 'report' | 'end'; title?: string; message?: string }
}

/** LSP semantic-tokens legend: index → token-type / modifier name. */
interface SemanticTokensLegend {
  tokenTypes: string[]
  tokenModifiers: string[]
}

/** Subset of the LSP `initialize` response we read (the semantic-tokens legend). */
interface InitializeResult {
  capabilities?: {
    semanticTokensProvider?: {
      legend?: SemanticTokensLegend
    }
  }
}
