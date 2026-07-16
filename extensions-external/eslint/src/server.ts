/**
 * Standalone ESLint language server. Spawned by the extension (client) as a
 * child of the extension host through Electron-as-node; talks standard LSP over
 * stdio via vscode-jsonrpc. Mirrors vscode-eslint's server role: it owns the
 * resolved ESLint instance, the open-document store, lints on open/change/save,
 * PUSHes diagnostics, and answers code-action / fix-all requests.
 *
 * The heavy lifting (resolving the workspace eslint, mapping results) lives in
 * eslintRunner.ts so it's unit-testable without a live process.
 */
import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
  type MessageConnection,
} from 'vscode-jsonrpc/node.js'
import {
  EslintMethods,
  type CodeActionParams,
  type DidChangeParams,
  type DidCloseParams,
  type DidOpenParams,
  type DidSaveParams,
  type EslintCodeAction,
  type EslintLogLevel,
  type EslintSettings,
  type EslintStatus,
  type FixAllParams,
  type FixAllResult,
  type InitializeParams,
  type LogMessageParams,
  type PublishDiagnosticsParams,
  type StatusParams,
  type UpdateSettingsParams,
} from './protocol.js'
import {
  buildCodeActions,
  computeFixAll,
  fileDirOf,
  filePathOf,
  findWorkingDirectory,
  lintDocument,
  resolveEslintClass,
  resolveEslintModule,
  type EslintApi,
  type EslintConstructor,
} from './eslintRunner.js'

interface OpenDoc {
  languageId: string
  version: number
  text: string
}

const DEFAULT_SETTINGS: EslintSettings = {
  validate: ['javascript', 'javascriptreact', 'typescript', 'typescriptreact'],
  run: 'onType',
  options: {},
}

/** ESLint class + the cwd config discovery must be anchored to (per working
 *  directory). `cwd` drives which config file eslint picks up. */
interface ResolvedEslint {
  readonly Ctor: EslintConstructor
  readonly cwd: string
}

class EslintServer {
  private _settings: EslintSettings = DEFAULT_SETTINGS
  private _workspaceRoot: string | undefined
  private readonly _open = new Map<string, OpenDoc>()
  /** ESLint resolved per working-directory + config mode (a monorepo may have
   *  several eslint installs and mixed flat/eslintrc configs). */
  private readonly _resolvedByKey = new Map<string, ResolvedEslint | undefined>()
  /** Serializes the process.chdir critical section — chdir is process-global, so
   *  concurrent lints of different working directories must not overlap. */
  private _cwdChain: Promise<unknown> = Promise.resolve()

  constructor(private readonly _conn: MessageConnection) {
    _conn.onRequest(EslintMethods.initialize, (p: InitializeParams) => {
      this._settings = p.settings
      this._workspaceRoot = p.rootUri ? (filePathOf(p.rootUri) ?? undefined) : undefined
      this._log(
        'info',
        `server initialized (run=${p.settings.run}, validate=[${p.settings.validate.join(', ')}])`,
      )
      this._status('ok')
      return { ok: true }
    })
    _conn.onNotification(EslintMethods.updateSettings, (p: UpdateSettingsParams) => {
      this._settings = p.settings
      this._log(
        'info',
        `settings updated (run=${p.settings.run}, validate=[${p.settings.validate.join(', ')}])`,
      )
      // Re-lint everything open so a validate/options change takes effect at once.
      for (const uri of this._open.keys()) void this._lintAndPublish(uri)
    })
    _conn.onNotification(EslintMethods.didOpen, (p: DidOpenParams) => {
      this._open.set(p.uri, { languageId: p.languageId, version: p.version, text: p.text })
      if (this._settings.run === 'onType') void this._lintAndPublish(p.uri)
    })
    _conn.onNotification(EslintMethods.didChange, (p: DidChangeParams) => {
      const doc = this._open.get(p.uri)
      if (doc) {
        doc.version = p.version
        doc.text = p.text
      }
      if (this._settings.run === 'onType') void this._lintAndPublish(p.uri)
    })
    _conn.onNotification(EslintMethods.didSave, (p: DidSaveParams) => {
      void this._lintAndPublish(p.uri)
    })
    _conn.onNotification(EslintMethods.didClose, (p: DidCloseParams) => {
      this._open.delete(p.uri)
      this._publish({ uri: p.uri, diagnostics: [] })
    })
    _conn.onRequest(
      EslintMethods.codeAction,
      (p: CodeActionParams): Promise<EslintCodeAction[]> => this._codeAction(p),
    )
    _conn.onRequest(
      EslintMethods.fixAllEdits,
      (p: FixAllParams): Promise<FixAllResult> => this._fixAll(p),
    )
  }

  private async _resolveFor(uri: string): Promise<ResolvedEslint | undefined> {
    const dir = fileDirOf(uri)
    const filePath = filePathOf(uri)
    if (!dir || !filePath) return undefined

    // Anchor config discovery to the file: walk up to the nearest eslint config
    // and use its directory as cwd so that config wins over an outer config.
    // Critical: even for eslintrc mode, cwd must be the config directory, not the
    // workspace root — otherwise ESLint 9 will walk past eslintrc and find the outer
    // flat config (flat config discovery is independent of useFlatConfig mode).
    const wd = findWorkingDirectory(this._workspaceRoot, filePath)

    const cwd = wd ? wd.directory : dir
    const useFlatConfig = wd?.isFlatConfig

    const key = `${dir}|${useFlatConfig ?? 'auto'}|${cwd}`
    if (this._resolvedByKey.has(key)) return this._resolvedByKey.get(key)

    try {
      const mod = await resolveEslintModule(dir)
      if (!mod) {
        this._log('warn', `no ESLint module resolvable from ${dir}`)
        this._resolvedByKey.set(key, undefined)
        return undefined
      }
      const Ctor = await resolveEslintClass(
        mod,
        useFlatConfig !== undefined ? { cwd, useFlatConfig } : { cwd },
      )
      if (!Ctor) {
        this._log('warn', `no ESLint class available from ${dir}`)
        this._resolvedByKey.set(key, undefined)
        return undefined
      }
      const resolved: ResolvedEslint = { Ctor, cwd }
      this._resolvedByKey.set(key, resolved)
      this._log(
        'info',
        `resolved ESLint from ${dir} (cwd=${cwd}, config=${wd ? (wd.isFlatConfig ? 'flat' : 'eslintrc') : 'auto'})`,
      )
      return resolved
    } catch (err) {
      this._log('error', `_resolveFor failed for ${dir}: ${(err as Error).message}`)
      this._resolvedByKey.set(key, undefined)
      return undefined
    }
  }

  private _shouldValidate(uri: string): boolean {
    const doc = this._open.get(uri)
    return !!doc && this._settings.validate.includes(doc.languageId)
  }

  private async _lintAndPublish(uri: string): Promise<void> {
    const doc = this._open.get(uri)
    if (!doc || !this._shouldValidate(uri)) return
    const filePath = filePathOf(uri)
    if (!filePath) return
    // Resolving the workspace eslint (first `import`) and the first type-aware
    // pass together take 10s+ on a large project. Flag busy up front — before
    // resolution — so the UI shows progress instead of looking broken; every
    // exit below clears it (via _status) so the spinner never sticks.
    this._status('ok', `Linting ${filePath}…`, true)
    // The first `import(eslint)` synchronously blocks this process's event loop
    // (V8 compiles the whole eslint + typescript-eslint module graph), which
    // would hold back the busy notification's stdout flush until it finishes —
    // defeating the point. Yield one turn so the notification reaches the client
    // (a separate process, free to render the spinner) before we block.
    await new Promise<void>((resolve) => setImmediate(resolve))
    const resolved = await this._resolveFor(uri)
    if (!resolved) {
      // eslint unresolvable (or cached negative) — settle to a definitive
      // status so the busy spinner always clears.
      this._status('warn', 'No ESLint library found in the workspace')
      return
    }
    try {
      const { diagnostics } = await this._withCwd(resolved.cwd, async () => {
        const eslint: EslintApi = new resolved.Ctor(this._optionsWithCwd(resolved.cwd))
        return lintDocument(eslint, doc.text, filePath)
      })
      this._log('info', `linted ${filePath}: ${diagnostics.length} problem(s)`)
      this._publish({ uri, diagnostics })
      this._status('ok')
    } catch (err) {
      this._log('error', `lint failed for ${filePath}: ${(err as Error).message}`)
      this._status('error', `Lint failed: ${(err as Error).message}`)
    }
  }

  /** ESLint constructor options with `cwd` merged in (drives config discovery). */
  private _optionsWithCwd(cwd: string): Record<string, unknown> {
    return { ...this._settings.options, cwd }
  }

  /**
   * Run `fn` with `process.cwd()` temporarily set to `cwd`, restoring it after.
   * eslint-plugin-import rules like `import/no-restricted-paths` resolve their
   * `basePath` against `process.cwd()` — NOT the ESLint `cwd` option — so the
   * server's spawn cwd (an arbitrary directory) makes those rules mis-fire.
   * Mirrors vscode-eslint's `withClass` process.chdir dance. Serialized because
   * chdir is process-global and lints run concurrently.
   */
  private _withCwd<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
    const run = this._cwdChain.then(async () => {
      const previous = process.cwd()
      let changed = false
      try {
        if (previous !== cwd) {
          process.chdir(cwd)
          changed = true
        }
      } catch (err) {
        this._log('warn', `chdir to ${cwd} failed: ${(err as Error).message}`)
      }
      try {
        return await fn()
      } finally {
        if (changed) {
          try {
            process.chdir(previous)
          } catch {
            // best-effort restore
          }
        }
      }
    })
    // Keep the chain alive regardless of this run's outcome.
    this._cwdChain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private async _codeAction(p: CodeActionParams): Promise<EslintCodeAction[]> {
    const doc = this._open.get(p.uri)
    if (!doc || !this._shouldValidate(p.uri)) return []
    const filePath = filePathOf(p.uri)
    if (!filePath) return []
    const resolved = await this._resolveFor(p.uri)
    if (!resolved) return []
    const options = this._optionsWithCwd(resolved.cwd)
    try {
      return await this._withCwd(resolved.cwd, async () => {
        const eslint: EslintApi = new resolved.Ctor(options)
        const { messages } = await lintDocument(eslint, doc.text, filePath)
        const actions = buildCodeActions(doc.text, messages, p.range)
        // Append a document-wide fix-all action when anything is fixable.
        const fixAllEdits = await computeFixAll(resolved.Ctor, options, doc.text, filePath)
        if (fixAllEdits.length > 0) {
          actions.push({
            title: 'Fix all auto-fixable ESLint problems',
            kind: 'source.fixAll.eslint',
            edits: fixAllEdits,
          })
        }
        return actions
      })
    } catch (err) {
      this._log('error', `codeAction failed for ${filePath}: ${(err as Error).message}`)
      return []
    }
  }

  private async _fixAll(p: FixAllParams): Promise<FixAllResult> {
    const doc = this._open.get(p.uri)
    if (!doc || !this._shouldValidate(p.uri)) return { edits: [] }
    const filePath = filePathOf(p.uri)
    if (!filePath) return { edits: [] }
    const resolved = await this._resolveFor(p.uri)
    if (!resolved) return { edits: [] }
    try {
      const edits = await this._withCwd(resolved.cwd, () =>
        computeFixAll(resolved.Ctor, this._optionsWithCwd(resolved.cwd), doc.text, filePath),
      )
      return { edits }
    } catch (err) {
      this._log('error', `fixAll failed for ${filePath}: ${(err as Error).message}`)
      return { edits: [] }
    }
  }

  private _publish(params: PublishDiagnosticsParams): void {
    void this._conn
      .sendNotification(EslintMethods.publishDiagnostics, params)
      .catch(() => undefined)
  }

  private _log(level: EslintLogLevel, message: string): void {
    const params: LogMessageParams = { level, message }
    void this._conn.sendNotification(EslintMethods.logMessage, params).catch(() => undefined)
  }

  private _status(status: EslintStatus, message?: string, busy?: boolean): void {
    const params: StatusParams = {
      status,
      ...(message !== undefined ? { message } : {}),
      ...(busy !== undefined ? { busy } : {}),
    }
    void this._conn.sendNotification(EslintMethods.status, params).catch(() => undefined)
  }
}

const connection = createMessageConnection(
  new StreamMessageReader(process.stdin),
  new StreamMessageWriter(process.stdout),
)
new EslintServer(connection)
connection.listen()
// Pre-handshake liveness marker; the client forwards server stderr to the
// ESLint output channel, so this confirms the subprocess actually spawned.
console.error('[eslint][server] process started, awaiting initialize')
