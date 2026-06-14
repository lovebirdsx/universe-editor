/**
 * Orchestrates the host's extensions: stores their command handlers, drives
 * lazy activation by event, and answers the renderer's RPC (contributions,
 * activate-by-event, execute-command). It also backs the global API bridge so
 * `commands.registerCommand` / `executeCommand` from inside an extension route
 * here.
 *
 * Errors are isolated per extension: a failed `activate` or a throwing handler
 * is logged to stderr and never tears down the host or other extensions.
 */
import { pathToFileURL } from 'node:url'
import {
  FileType,
  type AiApi,
  type CompletionItemProvider,
  type DefinitionProvider,
  type DiagnosticCollection,
  type Disposable,
  type DocumentSelector,
  type DocumentSymbolProvider,
  type ExtensionContext,
  type FileStat,
  type FoldingRangeProvider,
  type HoverProvider,
  type ImplementationProvider,
  type InputBoxOptions,
  type OutputChannel,
  type QuickPickItem,
  type QuickPickOptions,
  type ReferenceProvider,
  type RenameProvider,
  type SignatureHelpProvider,
  type SignatureHelpProviderMetadata,
  type SourceControl,
  type StatusBarAlignment,
  type StatusBarItem,
  type Selection,
  type TextDocument,
  type TextEditor,
  type TextEditorEdit,
  type TypeDefinitionProvider,
  type UriComponents,
  type WorkspaceSymbolProvider,
} from '@universe-editor/extension-api'
import {
  base64ToBytes,
  bytesToBase64,
  matchesActivationEvent,
  type ExtHostFileType,
  type ICompletionContext,
  type IExtHostFileStatDto,
  type IExtensionDescriptionDto,
  type ILanguageProviderMetadata,
  type ISelectionDto,
  type ITextEditDto,
  type IMainThreadCommands,
  type IMainThreadFs,
  type IMainThreadEditor,
  type IMainThreadLanguages,
  type IMainThreadOutput,
  type IMainThreadScm,
  type IMainThreadWindow,
  type IMainThreadAi,
  type IReferenceContext,
  type ISignatureHelpContext,
  type LanguageProviderType,
} from '@universe-editor/extensions-common'
import type {
  CompletionItem,
  CompletionList,
  Definition,
  DefinitionLink,
  Diagnostic,
  DocumentSymbol,
  FoldingRange,
  Hover,
  Location,
  Position,
  SignatureHelp,
  SymbolInformation,
  WorkspaceEdit,
  WorkspaceSymbol,
} from 'vscode-languageserver-types'
import type { IScannedExtension } from './extensionScanner.js'
import {
  createExtensionContext,
  installApiBridge,
  type IExtensionHostBridge,
} from './apiFactory.js'
import { HostSourceControl } from './hostScm.js'
import { HostAi } from './hostAi.js'
import { ExtHostDocuments, HostTextDocument } from './hostDocuments.js'

type CommandHandler = (...args: unknown[]) => unknown

function toFileType(type: ExtHostFileType): FileType {
  return type === 'dir' ? FileType.Directory : FileType.File
}

function toFileStat(dto: IExtHostFileStatDto): FileStat {
  return { type: toFileType(dto.type), size: dto.size, mtime: dto.mtime }
}

function toSelector(selector: DocumentSelector): readonly string[] {
  return typeof selector === 'string' ? [selector] : selector
}

/** Any of the language providers a plugin can register, keyed by its handle. */
type AnyLanguageProvider =
  | DefinitionProvider
  | ReferenceProvider
  | ImplementationProvider
  | TypeDefinitionProvider
  | HoverProvider
  | CompletionItemProvider
  | SignatureHelpProvider
  | DocumentSymbolProvider
  | RenameProvider
  | WorkspaceSymbolProvider
  | FoldingRangeProvider

interface RegisteredProvider {
  readonly type: LanguageProviderType
  readonly provider: AnyLanguageProvider
}

/**
 * Host-side DiagnosticCollection. `set`/`clear` push markers to the renderer
 * over `mainThreadLanguages`, keyed by the collection name (the marker owner).
 */
class HostDiagnosticCollection implements DiagnosticCollection {
  constructor(
    readonly name: string,
    private readonly _languages: IMainThreadLanguages,
  ) {}

  set(uri: UriComponents, diagnostics: readonly Diagnostic[] | undefined): void {
    if (diagnostics === undefined) {
      void this._languages.$clearDiagnostics(this.name, uri)
    } else {
      void this._languages.$publishDiagnostics(this.name, uri, diagnostics)
    }
  }

  delete(uri: UriComponents): void {
    void this._languages.$clearDiagnostics(this.name, uri)
  }

  clear(): void {
    void this._languages.$clearDiagnostics(this.name)
  }

  dispose(): void {
    this.clear()
  }
}

interface ActivatedExtension {
  readonly context: ExtensionContext
  readonly deactivate?: () => unknown
}

interface ExtensionModule {
  activate?: (context: ExtensionContext) => unknown
  deactivate?: () => unknown
}

/**
 * Host-side StatusBarItem. Mutations are pushed to the renderer only while the
 * item is shown; hiding/disposing removes its renderer entry. Keyed by `handle`.
 */
class HostStatusBarItem implements StatusBarItem {
  private _text = ''
  private _tooltip: string | undefined
  private _command: string | undefined
  private _showProgress: boolean | 'spinning' | 'syncing' | undefined
  private _visible = false

  constructor(
    private readonly _handle: number,
    readonly alignment: StatusBarAlignment,
    readonly priority: number,
    private readonly _window: IMainThreadWindow,
  ) {}

  get text(): string {
    return this._text
  }
  set text(value: string) {
    this._text = value
    this._sync()
  }
  get tooltip(): string | undefined {
    return this._tooltip
  }
  set tooltip(value: string | undefined) {
    this._tooltip = value
    this._sync()
  }
  get command(): string | undefined {
    return this._command
  }
  set command(value: string | undefined) {
    this._command = value
    this._sync()
  }
  get showProgress(): boolean | 'spinning' | 'syncing' | undefined {
    return this._showProgress
  }
  set showProgress(value: boolean | 'spinning' | 'syncing' | undefined) {
    this._showProgress = value
    this._sync()
  }

  show(): void {
    this._visible = true
    this._sync()
  }
  hide(): void {
    this._visible = false
    void this._window.$disposeStatusBarEntry(this._handle)
  }
  dispose(): void {
    this.hide()
  }

  private _sync(): void {
    if (!this._visible) return
    void this._window.$setStatusBarEntry(this._handle, {
      text: this._text,
      alignment: this.alignment,
      priority: this.priority,
      ...(this._tooltip !== undefined ? { tooltip: this._tooltip } : {}),
      ...(this._command !== undefined ? { command: this._command } : {}),
      ...(this._showProgress !== undefined ? { showProgress: this._showProgress } : {}),
    })
  }
}

/**
 * Host-side OutputChannel. Delegates append/clear/show/dispose over RPC to the
 * renderer's MainThreadOutput, which owns the real IOutputChannel instance.
 */
class HostOutputChannel implements OutputChannel {
  constructor(
    private readonly _handle: number,
    readonly name: string,
    private readonly _output: IMainThreadOutput,
  ) {}

  append(text: string): void {
    void this._output.$append(this._handle, text)
  }

  appendLine(text: string): void {
    void this._output.$append(this._handle, `${text}\n`)
  }

  clear(): void {
    void this._output.$clearOutputChannel(this._handle)
  }

  show(): void {
    void this._output.$showOutputChannel(this._handle)
  }

  dispose(): void {
    void this._output.$disposeOutputChannel(this._handle)
  }
}

/**
 * Host-side TextEditor handle. A snapshot of the editor at fetch time (document +
 * selections frozen); `edit` and `setSelections` drive the live editor over RPC.
 * An edit carries the snapshot's version so the renderer can reject it if the
 * document moved on, mirroring VSCode's optimistic-edit contract.
 */
class HostTextEditor implements TextEditor {
  constructor(
    readonly document: TextDocument,
    readonly selections: readonly Selection[],
    private readonly _version: number,
    private readonly _editorRpc: IMainThreadEditor,
  ) {}

  get selection(): Selection {
    return this.selections[0]!
  }

  edit(callback: (editBuilder: TextEditorEdit) => void): Promise<boolean> {
    const edits: ITextEditDto[] = []
    const builder: TextEditorEdit = {
      replace: (range, text) => edits.push({ range, text }),
      insert: (position, text) => edits.push({ range: { start: position, end: position }, text }),
      delete: (range) => edits.push({ range, text: '' }),
    }
    callback(builder)
    return this._editorRpc.$applyEdits(this.document.uri, this._version, edits)
  }

  setSelections(selections: readonly Selection[]): Promise<void> {
    return this._editorRpc.$setSelections(this.document.uri, selections.map(toSelectionDto))
  }
}

function toSelectionDto(sel: Selection): ISelectionDto {
  return { anchor: sel.anchor, active: sel.active }
}

export class ExtensionService implements IExtensionHostBridge {
  private readonly _commands = new Map<string, CommandHandler>()
  private readonly _activated = new Map<string, ActivatedExtension>()
  private readonly _activating = new Map<string, Promise<void>>()
  private _statusBarHandle = 0
  private readonly _sourceControls = new Map<number, HostSourceControl>()
  private _scmHandle = 0
  private _outputHandle = 0
  private readonly _providers = new Map<number, RegisteredProvider>()
  private _languageHandle = 0
  private _diagnosticHandle = 0
  private readonly _documents = new ExtHostDocuments()

  readonly onDidOpenTextDocument = this._documents.onDidOpen
  readonly onDidChangeTextDocument = this._documents.onDidChange
  readonly onDidCloseTextDocument = this._documents.onDidClose

  constructor(
    private readonly _extensions: readonly IScannedExtension[],
    private readonly _mainThreadCommands: IMainThreadCommands,
    private readonly _mainThreadWindow: IMainThreadWindow,
    private readonly _mainThreadScm: IMainThreadScm,
    private readonly _workspaceRoot?: string,
    private readonly _mainThreadFs?: IMainThreadFs,
    private readonly _kind: 'trusted' | 'restricted' = 'trusted',
    private readonly _mainThreadOutput?: IMainThreadOutput,
    private readonly _mainThreadLanguages?: IMainThreadLanguages,
    private readonly _mainThreadEditor?: IMainThreadEditor,
    private readonly _mainThreadAi?: IMainThreadAi,
  ) {
    installApiBridge(this)
  }

  // --- IExtensionHostBridge (called from inside extensions via the API) ---

  registerCommand(command: string, handler: CommandHandler): Disposable {
    if (this._commands.has(command)) {
      throw new Error(`command already registered: ${command}`)
    }
    this._commands.set(command, handler)
    void this._mainThreadCommands.$registerCommand(command)
    return {
      dispose: () => {
        if (this._commands.delete(command)) {
          void this._mainThreadCommands.$unregisterCommand(command)
        }
      },
    }
  }

  executeCommand(command: string, args: unknown[]): Promise<unknown> {
    const handler = this._commands.get(command)
    if (handler) {
      return Promise.resolve(handler(...args))
    }
    // Not one of this host's commands — forward to a renderer built-in (e.g.
    // `_workbench.openDiff`). The renderer rejects anything outside its
    // host-invokable namespace, so this can't loop back into extension commands.
    return this._mainThreadCommands.$executeCommand(command, args)
  }

  showMessage(
    severity: 'info' | 'warning' | 'error',
    message: string,
    items: string[],
  ): Promise<string | undefined> {
    return this._mainThreadWindow.$showMessage(severity, message, items)
  }

  showQuickPick(
    items: readonly (string | QuickPickItem)[],
    options?: QuickPickOptions,
  ): Promise<string | QuickPickItem | undefined> {
    const wireItems = items.map((it) =>
      typeof it === 'string'
        ? it
        : {
            label: it.label,
            ...(it.description !== undefined ? { description: it.description } : {}),
            ...(it.detail !== undefined ? { detail: it.detail } : {}),
          },
    )
    return this._mainThreadWindow
      .$showQuickPick(wireItems, options)
      .then((index) => (index === undefined ? undefined : items[index]))
  }

  showInputBox(options?: InputBoxOptions): Promise<string | undefined> {
    return this._mainThreadWindow.$showInputBox(options)
  }

  createStatusBarItem(alignment: StatusBarAlignment, priority: number): StatusBarItem {
    return new HostStatusBarItem(
      this._statusBarHandle++,
      alignment,
      priority,
      this._mainThreadWindow,
    )
  }

  createSourceControl(id: string, label: string, rootUri?: string): SourceControl {
    if (this._kind === 'restricted') {
      throw new Error(
        'scm.createSourceControl is not available to restricted (external) extensions',
      )
    }
    const handle = this._scmHandle++
    const sc = new HostSourceControl(
      handle,
      id,
      label,
      rootUri,
      this._mainThreadScm,
      () => this._scmHandle++,
      () => this._sourceControls.delete(handle),
    )
    this._sourceControls.set(handle, sc)
    void this._mainThreadScm.$registerSourceControl(handle, id, label, rootUri)
    return sc
  }

  getWorkspaceRoot(): string | undefined {
    return this._workspaceRoot
  }

  private _fs(): IMainThreadFs {
    if (!this._mainThreadFs) {
      throw new Error('filesystem access is not available in this extension host')
    }
    return this._mainThreadFs
  }

  fsReadFile(path: string): Promise<Uint8Array> {
    return this._fs()
      .$readFile(path)
      .then((base64) => base64ToBytes(base64))
  }

  fsWriteFile(path: string, content: Uint8Array): Promise<void> {
    return this._fs().$writeFile(path, bytesToBase64(content))
  }

  fsStat(path: string): Promise<FileStat> {
    return this._fs()
      .$stat(path)
      .then((dto) => toFileStat(dto))
  }

  fsReadDirectory(path: string): Promise<[string, FileType][]> {
    return this._fs()
      .$readDirectory(path)
      .then((entries) => entries.map(([name, type]) => [name, toFileType(type)]))
  }

  fsCreateDirectory(path: string): Promise<void> {
    return this._fs().$createDirectory(path)
  }

  fsDelete(path: string, recursive: boolean): Promise<void> {
    return this._fs().$delete(path, recursive)
  }

  getConfiguration(
    section: string | undefined,
    key: string,
    defaultValue: unknown,
  ): Promise<unknown> {
    const fullKey = section ? `${section}.${key}` : key
    return this.executeCommand('_workbench.getConfiguration', [fullKey, defaultValue])
  }

  createOutputChannel(name: string): OutputChannel {
    if (!this._mainThreadOutput) {
      throw new Error('output channel support is not available in this extension host')
    }
    const handle = this._outputHandle++
    void this._mainThreadOutput.$registerOutputChannel(handle, name)
    return new HostOutputChannel(handle, name, this._mainThreadOutput)
  }

  // --- editor: active text editor inspection + edits (trusted-only) ---

  private _editor(): IMainThreadEditor {
    if (!this._mainThreadEditor) {
      throw new Error('text editor access is not available in this extension host')
    }
    return this._mainThreadEditor
  }

  async getActiveTextEditor(): Promise<TextEditor | undefined> {
    const snapshot = await this._editor().$getActiveTextEditor()
    if (!snapshot) return undefined
    const document = new HostTextDocument(
      snapshot.uri,
      snapshot.languageId,
      snapshot.version,
      snapshot.text,
    )
    const selections = snapshot.selections.map((s) => ({ anchor: s.anchor, active: s.active }))
    return new HostTextEditor(document, selections, snapshot.version, this._editor())
  }

  // --- languages: provider registration (handle-routed, mirrors SCM) ---

  private _languages(): IMainThreadLanguages {
    if (!this._mainThreadLanguages) {
      throw new Error('language features are not available in this extension host')
    }
    return this._mainThreadLanguages
  }

  private _registerProvider(
    type: LanguageProviderType,
    selector: DocumentSelector,
    provider: AnyLanguageProvider,
    metadata?: ILanguageProviderMetadata,
  ): Disposable {
    const languages = this._languages()
    const handle = this._languageHandle++
    this._providers.set(handle, { type, provider })
    void languages.$registerProvider(handle, type, toSelector(selector), metadata)
    return {
      dispose: () => {
        if (this._providers.delete(handle)) void languages.$unregisterProvider(handle)
      },
    }
  }

  registerDefinitionProvider(selector: DocumentSelector, provider: DefinitionProvider): Disposable {
    return this._registerProvider('definition', selector, provider)
  }

  registerReferenceProvider(selector: DocumentSelector, provider: ReferenceProvider): Disposable {
    return this._registerProvider('references', selector, provider)
  }

  registerImplementationProvider(
    selector: DocumentSelector,
    provider: ImplementationProvider,
  ): Disposable {
    return this._registerProvider('implementation', selector, provider)
  }

  registerTypeDefinitionProvider(
    selector: DocumentSelector,
    provider: TypeDefinitionProvider,
  ): Disposable {
    return this._registerProvider('typeDefinition', selector, provider)
  }

  registerHoverProvider(selector: DocumentSelector, provider: HoverProvider): Disposable {
    return this._registerProvider('hover', selector, provider)
  }

  registerCompletionItemProvider(
    selector: DocumentSelector,
    provider: CompletionItemProvider,
    triggerCharacters: readonly string[],
  ): Disposable {
    return this._registerProvider(
      'completion',
      selector,
      provider,
      triggerCharacters.length > 0 ? { triggerCharacters } : undefined,
    )
  }

  registerSignatureHelpProvider(
    selector: DocumentSelector,
    provider: SignatureHelpProvider,
    metadata: SignatureHelpProviderMetadata,
  ): Disposable {
    return this._registerProvider('signatureHelp', selector, provider, {
      signatureHelpTriggerCharacters: metadata.triggerCharacters,
      signatureHelpRetriggerCharacters: metadata.retriggerCharacters,
    })
  }

  registerDocumentSymbolProvider(
    selector: DocumentSelector,
    provider: DocumentSymbolProvider,
  ): Disposable {
    return this._registerProvider('documentSymbol', selector, provider)
  }

  registerRenameProvider(selector: DocumentSelector, provider: RenameProvider): Disposable {
    return this._registerProvider('rename', selector, provider)
  }

  registerWorkspaceSymbolProvider(provider: WorkspaceSymbolProvider): Disposable {
    return this._registerProvider('workspaceSymbol', [], provider)
  }

  registerFoldingRangeProvider(
    selector: DocumentSelector,
    provider: FoldingRangeProvider,
  ): Disposable {
    return this._registerProvider('foldingRange', selector, provider)
  }

  createDiagnosticCollection(name?: string): DiagnosticCollection {
    return new HostDiagnosticCollection(
      name ?? `diagnostics-${this._diagnosticHandle++}`,
      this._languages(),
    )
  }

  // --- workspace documents ---

  getTextDocuments(): readonly TextDocument[] {
    return this._documents.all()
  }

  // --- ai: inference models (trusted-only) ---

  private _aiApi: AiApi | undefined

  get ai(): AiApi {
    if (!this._mainThreadAi) {
      throw new Error('AI model access is not available in this extension host')
    }
    return (this._aiApi ??= new HostAi(this._mainThreadAi))
  }

  // --- RPC surface (called from the renderer) ---

  private _provider<T extends AnyLanguageProvider>(
    handle: number,
    type: LanguageProviderType,
  ): T | undefined {
    const entry = this._providers.get(handle)
    return entry && entry.type === type ? (entry.provider as T) : undefined
  }

  /** IExtHostDocuments.$acceptDocumentOpen */
  acceptDocumentOpen(uri: UriComponents, languageId: string, version: number, text: string): void {
    this._documents.acceptOpen(uri, languageId, version, text)
  }

  /** IExtHostDocuments.$acceptDocumentChange */
  acceptDocumentChange(uri: UriComponents, version: number, text: string): void {
    this._documents.acceptChange(uri, version, text)
  }

  /** IExtHostDocuments.$acceptDocumentClose */
  acceptDocumentClose(uri: UriComponents): void {
    this._documents.acceptClose(uri)
  }

  /** IExtHostLanguages.$provideDefinition */
  async provideDefinition(
    handle: number,
    uri: UriComponents,
    position: Position,
  ): Promise<Definition | DefinitionLink[] | null> {
    const provider = this._provider<DefinitionProvider>(handle, 'definition')
    if (!provider) return null
    return (
      (await provider.provideDefinition(this._documents.getOrSynthesize(uri), position)) ?? null
    )
  }

  /** IExtHostLanguages.$provideReferences */
  async provideReferences(
    handle: number,
    uri: UriComponents,
    position: Position,
    context: IReferenceContext,
  ): Promise<Location[] | null> {
    const provider = this._provider<ReferenceProvider>(handle, 'references')
    if (!provider) return null
    return (
      (await provider.provideReferences(this._documents.getOrSynthesize(uri), position, context)) ??
      null
    )
  }

  /** IExtHostLanguages.$provideImplementation */
  async provideImplementation(
    handle: number,
    uri: UriComponents,
    position: Position,
  ): Promise<Definition | DefinitionLink[] | null> {
    const provider = this._provider<ImplementationProvider>(handle, 'implementation')
    if (!provider) return null
    return (
      (await provider.provideImplementation(this._documents.getOrSynthesize(uri), position)) ?? null
    )
  }

  /** IExtHostLanguages.$provideTypeDefinition */
  async provideTypeDefinition(
    handle: number,
    uri: UriComponents,
    position: Position,
  ): Promise<Definition | DefinitionLink[] | null> {
    const provider = this._provider<TypeDefinitionProvider>(handle, 'typeDefinition')
    if (!provider) return null
    return (
      (await provider.provideTypeDefinition(this._documents.getOrSynthesize(uri), position)) ?? null
    )
  }

  /** IExtHostLanguages.$provideHover */
  async provideHover(
    handle: number,
    uri: UriComponents,
    position: Position,
  ): Promise<Hover | null> {
    const provider = this._provider<HoverProvider>(handle, 'hover')
    if (!provider) return null
    return (await provider.provideHover(this._documents.getOrSynthesize(uri), position)) ?? null
  }

  /** IExtHostLanguages.$provideCompletion */
  async provideCompletion(
    handle: number,
    uri: UriComponents,
    position: Position,
    context: ICompletionContext,
  ): Promise<CompletionItem[] | CompletionList | null> {
    const provider = this._provider<CompletionItemProvider>(handle, 'completion')
    if (!provider) return null
    return (
      (await provider.provideCompletionItems(
        this._documents.getOrSynthesize(uri),
        position,
        context,
      )) ?? null
    )
  }

  /** IExtHostLanguages.$resolveCompletionItem */
  async resolveCompletionItem(handle: number, item: CompletionItem): Promise<CompletionItem> {
    const provider = this._provider<CompletionItemProvider>(handle, 'completion')
    if (!provider?.resolveCompletionItem) return item
    return (await provider.resolveCompletionItem(item)) ?? item
  }

  /** IExtHostLanguages.$provideSignatureHelp */
  async provideSignatureHelp(
    handle: number,
    uri: UriComponents,
    position: Position,
    context: ISignatureHelpContext,
  ): Promise<SignatureHelp | null> {
    const provider = this._provider<SignatureHelpProvider>(handle, 'signatureHelp')
    if (!provider) return null
    return (
      (await provider.provideSignatureHelp(
        this._documents.getOrSynthesize(uri),
        position,
        context,
      )) ?? null
    )
  }

  /** IExtHostLanguages.$provideDocumentSymbols */
  async provideDocumentSymbols(
    handle: number,
    uri: UriComponents,
  ): Promise<DocumentSymbol[] | SymbolInformation[] | null> {
    const provider = this._provider<DocumentSymbolProvider>(handle, 'documentSymbol')
    if (!provider) return null
    return (await provider.provideDocumentSymbols(this._documents.getOrSynthesize(uri))) ?? null
  }

  /** IExtHostLanguages.$provideRenameEdits */
  async provideRenameEdits(
    handle: number,
    uri: UriComponents,
    position: Position,
    newName: string,
  ): Promise<WorkspaceEdit | null> {
    const provider = this._provider<RenameProvider>(handle, 'rename')
    if (!provider) return null
    return (
      (await provider.provideRenameEdits(
        this._documents.getOrSynthesize(uri),
        position,
        newName,
      )) ?? null
    )
  }

  /** IExtHostLanguages.$provideWorkspaceSymbols */
  async provideWorkspaceSymbols(
    handle: number,
    query: string,
  ): Promise<WorkspaceSymbol[] | SymbolInformation[] | null> {
    const provider = this._provider<WorkspaceSymbolProvider>(handle, 'workspaceSymbol')
    if (!provider) return null
    return (await provider.provideWorkspaceSymbols(query)) ?? null
  }

  /** IExtHostLanguages.$provideFoldingRanges */
  async provideFoldingRanges(handle: number, uri: UriComponents): Promise<FoldingRange[] | null> {
    const provider = this._provider<FoldingRangeProvider>(handle, 'foldingRange')
    if (!provider) return null
    return (await provider.provideFoldingRanges(this._documents.getOrSynthesize(uri))) ?? null
  }

  /** IExtHostScm.$onInputBoxValueChange */
  onInputBoxValueChange(handle: number, value: string): void {
    this._sourceControls.get(handle)?.inputBox.acceptRendererValue(value)
  }

  /** IExtHostCommands.$executeContributedCommand */
  executeContributedCommand(id: string, args: unknown[]): Promise<unknown> {
    return this.executeCommand(id, args)
  }

  /** IExtHostExtensions.$getContributions */
  getContributions(): IExtensionDescriptionDto[] {
    return this._extensions.map((ext) => ({
      id: ext.id,
      name: ext.manifest.name,
      ...(ext.manifest.displayName !== undefined ? { displayName: ext.manifest.displayName } : {}),
      activationEvents: ext.manifest.activationEvents ?? [],
      contributes: ext.manifest.contributes ?? {},
    }))
  }

  /** IExtHostExtensions.$activateByEvent */
  async activateByEvent(event: string): Promise<void> {
    const pending: Promise<void>[] = []
    for (const ext of this._extensions) {
      if (matchesActivationEvent(ext.manifest.activationEvents ?? [], event)) {
        pending.push(this._activate(ext))
      }
    }
    await Promise.all(pending)
  }

  private _activate(ext: IScannedExtension): Promise<void> {
    if (this._activated.has(ext.id)) return Promise.resolve()
    const inFlight = this._activating.get(ext.id)
    if (inFlight) return inFlight

    const promise = this._doActivate(ext).finally(() => {
      this._activating.delete(ext.id)
    })
    this._activating.set(ext.id, promise)
    return promise
  }

  private async _doActivate(ext: IScannedExtension): Promise<void> {
    const context = createExtensionContext(ext)
    try {
      let deactivate: (() => unknown) | undefined
      if (ext.mainPath) {
        const mod = (await import(pathToFileURL(ext.mainPath).href)) as ExtensionModule
        await mod.activate?.(context)
        deactivate = mod.deactivate
      }
      this._activated.set(ext.id, {
        context,
        ...(deactivate !== undefined ? { deactivate } : {}),
      })
      console.error(`[ext-host] activated ${ext.id}`)
    } catch (err) {
      console.error(`[ext-host] activate failed ${ext.id}: ${(err as Error).stack ?? String(err)}`)
    }
  }
}
