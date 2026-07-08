/**
 * Orchestrates the host's extensions as a thin facade over four collaborators:
 * - {@link ExtensionCommandRegistry} — command handlers + execution routing,
 * - {@link LanguageProviderRegistry} — language-feature providers + `provide*` RPC,
 * - {@link ExtensionActivationService} — lazy activation by event,
 * - the Host* handle objects in `hostHandles.ts` — status bar / output / editor.
 *
 * It implements {@link IExtensionHostBridge} (installed on globalThis so the
 * bundled extension-api delegates here) and answers the renderer's RPC. The
 * heavy lifting lives in the collaborators; this class wires them to the
 * MainThread* dependencies and forwards calls.
 *
 * Errors are isolated per extension (see ExtensionActivationService).
 */
import { Emitter, type Event } from '@universe-editor/platform'
import {
  FileType,
  type AiApi,
  type CodeActionProvider,
  type CompletionItemProvider,
  type CustomEditorOptions,
  type CustomReadonlyEditorProvider,
  type DecorationRenderOptions,
  type DefinitionProvider,
  type DiagnosticCollection,
  type Disposable,
  type DocumentSelector,
  type DocumentHighlightProvider,
  type DocumentLinkProvider,
  type DocumentSymbolProvider,
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
  type SelectionRangeProvider,
  type SignatureHelpProvider,
  type SignatureHelpProviderMetadata,
  type SourceControl,
  type StatusBarAlignment,
  type StatusBarItem,
  type TextDocument,
  type TextEditor,
  type TextEditorDecorationType,
  type TypeDefinitionProvider,
  type UriComponents,
  type WorkspaceSymbolProvider,
} from '@universe-editor/extension-api'
import {
  base64ToBytes,
  bytesToBase64,
  type ExtHostFileType,
  type IActiveTextEditorDto,
  type ICodeActionContext,
  type ICompletionContext,
  type IExtHostFileStatDto,
  type IExtensionDescriptionDto,
  type IReferenceContext,
  type ISignatureHelpContext,
  type IMainThreadCommands,
  type IMainThreadFs,
  type IMainThreadEditor,
  type IMainThreadLanguages,
  type IMainThreadOutput,
  type IMainThreadScm,
  type IMainThreadWindow,
  type IMainThreadAi,
  type IMainThreadStorage,
  type IMainThreadWebviews,
} from '@universe-editor/extensions-common'
import type {
  CodeAction,
  CompletionItem,
  CompletionList,
  Definition,
  DefinitionLink,
  DocumentHighlight,
  DocumentLink,
  DocumentSymbol,
  FoldingRange,
  Hover,
  Location,
  Position,
  Range,
  SelectionRange,
  SignatureHelp,
  SymbolInformation,
  WorkspaceEdit,
  WorkspaceSymbol,
} from 'vscode-languageserver-types'
import type { IScannedExtension } from './extensionScanner.js'
import { installApiBridge, type IExtensionHostBridge } from './apiFactory.js'
import { HostSourceControl } from './hostScm.js'
import { HostWebviewManager } from './hostWebviews.js'
import { HostAi } from './hostAi.js'
import { ExtHostDocuments, HostTextDocument } from './hostDocuments.js'
import {
  HostOutputChannel,
  HostStatusBarItem,
  HostTextEditor,
  HostTextEditorDecorationType,
  toDecorationOptionsDto,
} from './hostHandles.js'
import { ExtensionCommandRegistry } from './commandRegistry.js'
import { LanguageProviderRegistry } from './languageProviderRegistry.js'
import { ExtensionActivationService } from './activationService.js'

function toFileType(type: ExtHostFileType): FileType {
  return type === 'dir' ? FileType.Directory : FileType.File
}

function toFileStat(dto: IExtHostFileStatDto): FileStat {
  return { type: toFileType(dto.type), size: dto.size, mtime: dto.mtime }
}

export class ExtensionService implements IExtensionHostBridge {
  private readonly _commands: ExtensionCommandRegistry
  private readonly _languageRegistry: LanguageProviderRegistry
  private readonly _activation: ExtensionActivationService
  private readonly _documents = new ExtHostDocuments()
  private readonly _sourceControls = new Map<number, HostSourceControl>()
  private readonly _webviews?: HostWebviewManager
  private _statusBarHandle = 0
  private _scmHandle = 0
  private _outputHandle = 0
  private _decorationTypeHandle = 0

  private readonly _onDidChangeActiveTextEditor = new Emitter<TextEditor | undefined>()
  readonly onDidChangeActiveTextEditor: Event<TextEditor | undefined> =
    this._onDidChangeActiveTextEditor.event

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
    private readonly _mainThreadStorage?: IMainThreadStorage,
    private readonly _mainThreadWebviews?: IMainThreadWebviews,
  ) {
    this._commands = new ExtensionCommandRegistry(_mainThreadCommands)
    this._languageRegistry = new LanguageProviderRegistry(() => this._languages(), this._documents)
    this._activation = new ExtensionActivationService(_extensions, _mainThreadStorage)
    if (_mainThreadWebviews) this._webviews = new HostWebviewManager(_mainThreadWebviews)
    installApiBridge(this)
  }

  // --- IExtensionHostBridge: commands ---

  registerCommand(command: string, handler: (...args: unknown[]) => unknown): Disposable {
    return this._commands.register(command, handler)
  }

  executeCommand(command: string, args: unknown[]): Promise<unknown> {
    return this._commands.execute(command, args)
  }

  // --- IExtensionHostBridge: window ---

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
            ...(it.iconId !== undefined ? { iconId: it.iconId } : {}),
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

  createOutputChannel(name: string): OutputChannel {
    if (!this._mainThreadOutput) {
      throw new Error('output channel support is not available in this extension host')
    }
    const handle = this._outputHandle++
    void this._mainThreadOutput.$registerOutputChannel(handle, name)
    return new HostOutputChannel(handle, name, this._mainThreadOutput)
  }

  // --- IExtensionHostBridge: webview / custom editors ---

  registerCustomEditorProvider(
    viewType: string,
    provider: CustomReadonlyEditorProvider,
    options?: CustomEditorOptions,
  ): Disposable {
    if (!this._webviews) {
      throw new Error('custom editor support is not available in this extension host')
    }
    return this._webviews.registerCustomEditorProvider(viewType, provider, options)
  }

  /** IExtHostWebviews.$resolveCustomEditor */
  resolveCustomEditor(
    providerHandle: number,
    panelHandle: number,
    viewType: string,
    uri: UriComponents,
  ): Promise<void> {
    if (!this._webviews) {
      throw new Error('custom editor support is not available in this extension host')
    }
    return this._webviews.resolveCustomEditor(providerHandle, panelHandle, viewType, uri)
  }

  /** IExtHostWebviews.$onDidReceiveMessage */
  acceptWebviewMessage(panelHandle: number, message: unknown): void {
    this._webviews?.acceptMessage(panelHandle, message)
  }

  /** IExtHostWebviews.$disposeWebviewPanel */
  disposeWebviewPanel(panelHandle: number): void {
    this._webviews?.disposePanel(panelHandle)
  }

  // --- IExtensionHostBridge: scm ---

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

  // --- IExtensionHostBridge: workspace ---

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

  getTextDocuments(): readonly TextDocument[] {
    return this._documents.all()
  }

  // --- IExtensionHostBridge: editor (trusted-only) ---

  private _editor(): IMainThreadEditor {
    if (!this._mainThreadEditor) {
      throw new Error('text editor access is not available in this extension host')
    }
    return this._mainThreadEditor
  }

  async getActiveTextEditor(): Promise<TextEditor | undefined> {
    const snapshot = await this._editor().$getActiveTextEditor()
    return snapshot ? this._editorFromSnapshot(snapshot) : undefined
  }

  private _editorFromSnapshot(snapshot: IActiveTextEditorDto): TextEditor {
    const document = new HostTextDocument(
      snapshot.uri,
      snapshot.languageId,
      snapshot.version,
      snapshot.text,
    )
    const selections = snapshot.selections.map((s) => ({ anchor: s.anchor, active: s.active }))
    return new HostTextEditor(document, selections, snapshot.version, this._editor())
  }

  createTextEditorDecorationType(options: DecorationRenderOptions): TextEditorDecorationType {
    const handle = this._decorationTypeHandle++
    void this._editor().$createDecorationType(handle, toDecorationOptionsDto(options))
    return new HostTextEditorDecorationType(handle, this._editor())
  }

  /** IExtHostEditor.$acceptActiveEditorChange — renderer mirrors editor focus changes. */
  acceptActiveEditorChange(snapshot: IActiveTextEditorDto | null): void {
    this._onDidChangeActiveTextEditor.fire(
      snapshot ? this._editorFromSnapshot(snapshot) : undefined,
    )
  }

  // --- IExtensionHostBridge: languages ---

  private _languages(): IMainThreadLanguages {
    if (!this._mainThreadLanguages) {
      throw new Error('language features are not available in this extension host')
    }
    return this._mainThreadLanguages
  }

  registerDefinitionProvider(selector: DocumentSelector, provider: DefinitionProvider): Disposable {
    return this._languageRegistry.registerDefinitionProvider(selector, provider)
  }

  registerReferenceProvider(selector: DocumentSelector, provider: ReferenceProvider): Disposable {
    return this._languageRegistry.registerReferenceProvider(selector, provider)
  }

  registerImplementationProvider(
    selector: DocumentSelector,
    provider: ImplementationProvider,
  ): Disposable {
    return this._languageRegistry.registerImplementationProvider(selector, provider)
  }

  registerTypeDefinitionProvider(
    selector: DocumentSelector,
    provider: TypeDefinitionProvider,
  ): Disposable {
    return this._languageRegistry.registerTypeDefinitionProvider(selector, provider)
  }

  registerHoverProvider(selector: DocumentSelector, provider: HoverProvider): Disposable {
    return this._languageRegistry.registerHoverProvider(selector, provider)
  }

  registerCompletionItemProvider(
    selector: DocumentSelector,
    provider: CompletionItemProvider,
    triggerCharacters: readonly string[],
  ): Disposable {
    return this._languageRegistry.registerCompletionItemProvider(
      selector,
      provider,
      triggerCharacters,
    )
  }

  registerSignatureHelpProvider(
    selector: DocumentSelector,
    provider: SignatureHelpProvider,
    metadata: SignatureHelpProviderMetadata,
  ): Disposable {
    return this._languageRegistry.registerSignatureHelpProvider(selector, provider, metadata)
  }

  registerDocumentSymbolProvider(
    selector: DocumentSelector,
    provider: DocumentSymbolProvider,
  ): Disposable {
    return this._languageRegistry.registerDocumentSymbolProvider(selector, provider)
  }

  registerRenameProvider(selector: DocumentSelector, provider: RenameProvider): Disposable {
    return this._languageRegistry.registerRenameProvider(selector, provider)
  }

  registerWorkspaceSymbolProvider(provider: WorkspaceSymbolProvider): Disposable {
    return this._languageRegistry.registerWorkspaceSymbolProvider(provider)
  }

  registerFoldingRangeProvider(
    selector: DocumentSelector,
    provider: FoldingRangeProvider,
  ): Disposable {
    return this._languageRegistry.registerFoldingRangeProvider(selector, provider)
  }

  registerDocumentLinkProvider(
    selector: DocumentSelector,
    provider: DocumentLinkProvider,
  ): Disposable {
    return this._languageRegistry.registerDocumentLinkProvider(selector, provider)
  }

  registerDocumentHighlightProvider(
    selector: DocumentSelector,
    provider: DocumentHighlightProvider,
  ): Disposable {
    return this._languageRegistry.registerDocumentHighlightProvider(selector, provider)
  }

  registerSelectionRangeProvider(
    selector: DocumentSelector,
    provider: SelectionRangeProvider,
  ): Disposable {
    return this._languageRegistry.registerSelectionRangeProvider(selector, provider)
  }

  registerCodeActionsProvider(
    selector: DocumentSelector,
    provider: CodeActionProvider,
  ): Disposable {
    return this._languageRegistry.registerCodeActionsProvider(selector, provider)
  }

  createDiagnosticCollection(name?: string): DiagnosticCollection {
    return this._languageRegistry.createDiagnosticCollection(name)
  }

  // --- IExtensionHostBridge: ai (trusted-only) ---

  private _aiApi: AiApi | undefined

  get ai(): AiApi {
    if (!this._mainThreadAi) {
      throw new Error('AI model access is not available in this extension host')
    }
    return (this._aiApi ??= new HostAi(this._mainThreadAi))
  }

  // --- RPC surface: documents (called from the renderer) ---

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

  // --- RPC surface: languages (delegated to the registry) ---

  provideDefinition(
    handle: number,
    uri: UriComponents,
    position: Position,
  ): Promise<Definition | DefinitionLink[] | null> {
    return this._languageRegistry.provideDefinition(handle, uri, position)
  }

  provideReferences(
    handle: number,
    uri: UriComponents,
    position: Position,
    context: IReferenceContext,
  ): Promise<Location[] | null> {
    return this._languageRegistry.provideReferences(handle, uri, position, context)
  }

  provideImplementation(
    handle: number,
    uri: UriComponents,
    position: Position,
  ): Promise<Definition | DefinitionLink[] | null> {
    return this._languageRegistry.provideImplementation(handle, uri, position)
  }

  provideTypeDefinition(
    handle: number,
    uri: UriComponents,
    position: Position,
  ): Promise<Definition | DefinitionLink[] | null> {
    return this._languageRegistry.provideTypeDefinition(handle, uri, position)
  }

  provideHover(handle: number, uri: UriComponents, position: Position): Promise<Hover | null> {
    return this._languageRegistry.provideHover(handle, uri, position)
  }

  provideCompletion(
    handle: number,
    uri: UriComponents,
    position: Position,
    context: ICompletionContext,
  ): Promise<CompletionItem[] | CompletionList | null> {
    return this._languageRegistry.provideCompletion(handle, uri, position, context)
  }

  resolveCompletionItem(handle: number, item: CompletionItem): Promise<CompletionItem> {
    return this._languageRegistry.resolveCompletionItem(handle, item)
  }

  provideSignatureHelp(
    handle: number,
    uri: UriComponents,
    position: Position,
    context: ISignatureHelpContext,
  ): Promise<SignatureHelp | null> {
    return this._languageRegistry.provideSignatureHelp(handle, uri, position, context)
  }

  provideDocumentSymbols(
    handle: number,
    uri: UriComponents,
  ): Promise<DocumentSymbol[] | SymbolInformation[] | null> {
    return this._languageRegistry.provideDocumentSymbols(handle, uri)
  }

  provideRenameEdits(
    handle: number,
    uri: UriComponents,
    position: Position,
    newName: string,
  ): Promise<WorkspaceEdit | null> {
    return this._languageRegistry.provideRenameEdits(handle, uri, position, newName)
  }

  provideWorkspaceSymbols(
    handle: number,
    query: string,
  ): Promise<WorkspaceSymbol[] | SymbolInformation[] | null> {
    return this._languageRegistry.provideWorkspaceSymbols(handle, query)
  }

  provideFoldingRanges(handle: number, uri: UriComponents): Promise<FoldingRange[] | null> {
    return this._languageRegistry.provideFoldingRanges(handle, uri)
  }

  provideDocumentLinks(handle: number, uri: UriComponents): Promise<DocumentLink[] | null> {
    return this._languageRegistry.provideDocumentLinks(handle, uri)
  }

  resolveDocumentLink(handle: number, link: DocumentLink): Promise<DocumentLink | null> {
    return this._languageRegistry.resolveDocumentLink(handle, link)
  }

  provideDocumentHighlights(
    handle: number,
    uri: UriComponents,
    position: Position,
  ): Promise<DocumentHighlight[] | null> {
    return this._languageRegistry.provideDocumentHighlights(handle, uri, position)
  }

  provideSelectionRanges(
    handle: number,
    uri: UriComponents,
    positions: Position[],
  ): Promise<SelectionRange[] | null> {
    return this._languageRegistry.provideSelectionRanges(handle, uri, positions)
  }

  provideCodeActions(
    handle: number,
    uri: UriComponents,
    range: Range,
    context: ICodeActionContext,
  ): Promise<CodeAction[] | null> {
    return this._languageRegistry.provideCodeActions(handle, uri, range, context)
  }

  // --- RPC surface: scm / commands / extensions ---

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
    return this._extensions.map((ext) => {
      // Drop the manifest-form jsonValidation (file urls) — the DTO carries the
      // host-resolved inline schemas instead, if any resolved successfully.
      const { jsonValidation: _urls, ...contributes } = ext.manifest.contributes ?? {}
      return {
        id: ext.id,
        name: ext.manifest.name,
        ...(ext.manifest.displayName !== undefined
          ? { displayName: ext.manifest.displayName }
          : {}),
        activationEvents: ext.manifest.activationEvents ?? [],
        contributes: {
          ...contributes,
          ...(ext.resolvedJsonValidation !== undefined
            ? { jsonValidation: ext.resolvedJsonValidation }
            : {}),
        },
      }
    })
  }

  /** IExtHostExtensions.$activateByEvent */
  activateByEvent(event: string): Promise<void> {
    return this._activation.activateByEvent(event)
  }

  /**
   * Tear down every activated extension (deactivate + dispose subscriptions).
   * Called on host shutdown so extensions release OS resources — notably child
   * processes they spawned (typescript plugin's tsserver), which would otherwise
   * orphan when the host process dies.
   */
  dispose(): void {
    this._webviews?.dispose()
    this._activation.disposeAll()
  }
}
