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
  type EslintSettings,
  type FixAllParams,
  type FixAllResult,
  type InitializeParams,
  type PublishDiagnosticsParams,
  type UpdateSettingsParams,
} from './protocol.js'
import {
  buildCodeActions,
  computeFixAll,
  fileDirOf,
  filePathOf,
  lintDocument,
  resolveEslintConstructor,
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

class EslintServer {
  private _settings: EslintSettings = DEFAULT_SETTINGS
  private readonly _open = new Map<string, OpenDoc>()
  /** ESLint constructor resolved per file directory (a monorepo may have several). */
  private readonly _ctorByDir = new Map<string, EslintConstructor | undefined>()

  constructor(private readonly _conn: MessageConnection) {
    _conn.onRequest(EslintMethods.initialize, (p: InitializeParams) => {
      this._settings = p.settings
      return { ok: true }
    })
    _conn.onNotification(EslintMethods.updateSettings, (p: UpdateSettingsParams) => {
      this._settings = p.settings
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

  private async _ctorFor(uri: string): Promise<EslintConstructor | undefined> {
    const dir = fileDirOf(uri)
    if (!dir) return undefined
    if (this._ctorByDir.has(dir)) return this._ctorByDir.get(dir)
    const ctor = await resolveEslintConstructor(dir)
    this._ctorByDir.set(dir, ctor)
    if (!ctor) console.error(`[eslint][server] no eslint resolvable from ${dir}`)
    return ctor
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
    const Ctor = await this._ctorFor(uri)
    if (!Ctor) return
    try {
      const eslint: EslintApi = new Ctor(this._settings.options)
      const { diagnostics } = await lintDocument(eslint, doc.text, filePath)
      this._publish({ uri, diagnostics })
    } catch (err) {
      console.error(`[eslint][server] lint failed for ${uri}: ${(err as Error).message}`)
    }
  }

  private async _codeAction(p: CodeActionParams): Promise<EslintCodeAction[]> {
    const doc = this._open.get(p.uri)
    if (!doc || !this._shouldValidate(p.uri)) return []
    const filePath = filePathOf(p.uri)
    if (!filePath) return []
    const Ctor = await this._ctorFor(p.uri)
    if (!Ctor) return []
    try {
      const eslint: EslintApi = new Ctor(this._settings.options)
      const { messages } = await lintDocument(eslint, doc.text, filePath)
      const actions = buildCodeActions(doc.text, messages, p.range)
      // Append a document-wide fix-all action when anything is fixable.
      const fixAllEdits = await computeFixAll(Ctor, this._settings.options, doc.text, filePath)
      if (fixAllEdits.length > 0) {
        actions.push({
          title: 'Fix all auto-fixable ESLint problems',
          kind: 'source.fixAll.eslint',
          edits: fixAllEdits,
        })
      }
      return actions
    } catch (err) {
      console.error(`[eslint][server] codeAction failed for ${p.uri}: ${(err as Error).message}`)
      return []
    }
  }

  private async _fixAll(p: FixAllParams): Promise<FixAllResult> {
    const doc = this._open.get(p.uri)
    if (!doc || !this._shouldValidate(p.uri)) return { edits: [] }
    const filePath = filePathOf(p.uri)
    if (!filePath) return { edits: [] }
    const Ctor = await this._ctorFor(p.uri)
    if (!Ctor) return { edits: [] }
    try {
      const edits = await computeFixAll(Ctor, this._settings.options, doc.text, filePath)
      return { edits }
    } catch (err) {
      console.error(`[eslint][server] fixAll failed for ${p.uri}: ${(err as Error).message}`)
      return { edits: [] }
    }
  }

  private _publish(params: PublishDiagnosticsParams): void {
    void this._conn
      .sendNotification(EslintMethods.publishDiagnostics, params)
      .catch(() => undefined)
  }
}

const connection = createMessageConnection(
  new StreamMessageReader(process.stdin),
  new StreamMessageWriter(process.stdout),
)
new EslintServer(connection)
connection.listen()
console.error('[eslint][server] started')
