/**
 * Builds the runtime API injected into extensions. The single global bridge
 * (installed before any extension is imported) backs the `commands` namespace
 * of `@universe-editor/extension-api`; per-extension `ExtensionContext` objects
 * are created at activation time.
 */
import type {
  AiApi,
  CancellationToken,
  CodeActionProvider,
  CodeLensProvider,
  CompletionItemProvider,
  ConfigurationChangeEvent,
  CustomEditorOptions,
  CustomReadonlyEditorProvider,
  DecorationRenderOptions,
  DefinitionProvider,
  DiagnosticCollection,
  Disposable,
  DocumentFormattingEditProvider,
  DocumentHighlightProvider,
  DocumentLinkProvider,
  DocumentRangeFormattingEditProvider,
  DocumentSelector,
  DocumentSemanticTokensProvider,
  DocumentSymbolProvider,
  Event,
  Extension,
  ExtensionContext,
  FileStat,
  FileType,
  FoldingRangeProvider,
  HoverProvider,
  ImplementationProvider,
  InlayHintsProvider,
  InputBoxOptions,
  LanguageServerStatus,
  Memento,
  OnTypeFormattingEditProvider,
  OutputChannel,
  Progress,
  ProgressOptions,
  QuickPickItem,
  QuickPickOptions,
  ReferenceProvider,
  RenameProvider,
  SelectionRangeProvider,
  SignatureHelpProvider,
  SignatureHelpProviderMetadata,
  SourceControl,
  StatusBarAlignment,
  StatusBarItem,
  TextDocument,
  TextDocumentChangeEvent,
  TextDocumentShowOptions,
  TextEditor,
  TextEditorDecorationType,
  TextEditorSelectionChangeEvent,
  TimelineProvider,
  TypeDefinitionProvider,
  UriComponents,
  WillSaveTextDocumentEvent,
  WorkspaceEdit,
  WorkspaceSymbolProvider,
} from '@universe-editor/extension-api'
import type { IScannedExtension } from './extensionScanner.js'
import type {
  ExtHostStorageScope,
  IExtHostEnvironmentDto,
  IMainThreadStorage,
} from '@universe-editor/extensions-common'
import { join } from 'node:path'

/** The slice of the storage RPC the context factory needs (whole-object get/set). */
export type IExtensionStorage = IMainThreadStorage

/**
 * Global key the bridge is installed under. KEEP IN SYNC with the consumer in
 * `packages/extension-api/src/index.ts` (same key, same method shapes).
 */
const BRIDGE_KEY = '__universeExtensionHostBridge__'

/**
 * Dialog options as they arrive over the bridge: `defaultUri` is decomposed
 * into `UriComponents` by the extension-api wrapper, so the host never touches
 * an extension's bundled `Uri` class instance. KEEP IN SYNC with the consumer
 * types in `packages/extension-api/src/index.ts`.
 */
export interface OpenDialogOptionsBridge {
  defaultUri?: UriComponents
  openLabel?: string
  canSelectFiles?: boolean
  canSelectFolders?: boolean
  canSelectMany?: boolean
  filters?: Record<string, string[]>
  title?: string
}

/** See {@link OpenDialogOptionsBridge}. */
export interface SaveDialogOptionsBridge {
  defaultUri?: UriComponents
  saveLabel?: string
  filters?: Record<string, string[]>
  title?: string
}

/**
 * The watcher handle handed back over the in-process bridge. Events carry raw
 * `UriComponents`; the extension-api wrapper re-wraps them into the extension's
 * own `Uri` class. KEEP IN SYNC with the consumer types in
 * `packages/extension-api/src/index.ts`.
 */
export interface FileSystemWatcherBridge extends Disposable {
  readonly ignoreCreateEvents: boolean
  readonly ignoreChangeEvents: boolean
  readonly ignoreDeleteEvents: boolean
  readonly onDidCreate: Event<UriComponents>
  readonly onDidChange: Event<UriComponents>
  readonly onDidDelete: Event<UriComponents>
}

/** The bridge the extension-api delegates to. Matches `IExtensionHostBridge` there. */
export interface IExtensionHostBridge {
  registerCommand(command: string, handler: (...args: unknown[]) => unknown): Disposable
  executeCommand(command: string, args: unknown[]): Promise<unknown>
  getCommands(): Promise<string[]>
  getEnvironmentInfo(): IExtHostEnvironmentDto
  clipboardReadText(): Promise<string>
  clipboardWriteText(value: string): Promise<void>
  openExternal(target: string): Promise<boolean>
  getExtensions(): readonly Extension<unknown>[]
  getExtension(extensionId: string): Extension<unknown> | undefined
  readonly onDidChangeExtensions: Event<void>
  showMessage(
    severity: 'info' | 'warning' | 'error',
    message: string,
    items: string[],
  ): Promise<string | undefined>
  showQuickPick(
    items: readonly (string | QuickPickItem)[],
    options?: QuickPickOptions,
  ): Promise<string | QuickPickItem | undefined>
  showInputBox(options?: InputBoxOptions): Promise<string | undefined>
  createStatusBarItem(alignment: StatusBarAlignment, priority: number): StatusBarItem
  setStatusBarMessage(text: string, arg?: number | Promise<unknown>): Disposable
  withProgress<R>(
    options: ProgressOptions,
    task: (
      progress: Progress<{ message?: string; increment?: number }>,
      token: CancellationToken,
    ) => Promise<R>,
  ): Promise<R>
  showOpenDialog(options?: OpenDialogOptionsBridge): Promise<UriComponents[] | undefined>
  showSaveDialog(options?: SaveDialogOptionsBridge): Promise<UriComponents | undefined>
  showTextDocument(
    target: UriComponents | string,
    options?: TextDocumentShowOptions,
  ): Promise<TextEditor>
  openTextDocument(target: UriComponents | string): Promise<TextDocument>
  readonly onDidChangeTextEditorSelection: Event<TextEditorSelectionChangeEvent>
  createSourceControl(id: string, label: string, rootUri?: string): SourceControl
  registerTimelineProvider(scheme: string[], provider: TimelineProvider): Disposable
  getActiveTextEditor(): Promise<TextEditor | undefined>
  readonly onDidChangeActiveTextEditor: Event<TextEditor | undefined>
  createTextEditorDecorationType(options: DecorationRenderOptions): TextEditorDecorationType
  registerCustomEditorProvider(
    viewType: string,
    provider: CustomReadonlyEditorProvider,
    options?: CustomEditorOptions,
  ): Disposable
  getWorkspaceRoot(): string | undefined
  fsReadFile(path: string): Promise<Uint8Array>
  fsWriteFile(path: string, content: Uint8Array): Promise<void>
  fsStat(path: string): Promise<FileStat>
  fsReadDirectory(path: string): Promise<[string, FileType][]>
  fsCreateDirectory(path: string): Promise<void>
  fsDelete(path: string, recursive: boolean): Promise<void>
  fsRename(source: string, target: string, overwrite: boolean): Promise<void>
  fsCopy(source: string, target: string, overwrite: boolean): Promise<void>
  /**
   * `exclude` carries API semantics: undefined → the renderer's configured
   * default search excludes; null → no exclusion at all; a string → that glob.
   * Returns fsPaths.
   */
  findFiles(
    include: string,
    exclude: string | null | undefined,
    maxResults: number | undefined,
  ): Promise<string[]>
  applyWorkspaceEdit(edit: WorkspaceEdit): Promise<boolean>
  createFileSystemWatcher(
    globPattern: string,
    ignoreCreateEvents: boolean,
    ignoreChangeEvents: boolean,
    ignoreDeleteEvents: boolean,
  ): FileSystemWatcherBridge
  getConfiguration(
    section: string | undefined,
    key: string,
    defaultValue: unknown,
  ): Promise<unknown>
  createOutputChannel(name: string): OutputChannel
  registerDefinitionProvider(selector: DocumentSelector, provider: DefinitionProvider): Disposable
  registerReferenceProvider(selector: DocumentSelector, provider: ReferenceProvider): Disposable
  registerImplementationProvider(
    selector: DocumentSelector,
    provider: ImplementationProvider,
  ): Disposable
  registerTypeDefinitionProvider(
    selector: DocumentSelector,
    provider: TypeDefinitionProvider,
  ): Disposable
  registerHoverProvider(selector: DocumentSelector, provider: HoverProvider): Disposable
  registerCompletionItemProvider(
    selector: DocumentSelector,
    provider: CompletionItemProvider,
    triggerCharacters: readonly string[],
  ): Disposable
  registerSignatureHelpProvider(
    selector: DocumentSelector,
    provider: SignatureHelpProvider,
    metadata: SignatureHelpProviderMetadata,
  ): Disposable
  registerDocumentSymbolProvider(
    selector: DocumentSelector,
    provider: DocumentSymbolProvider,
  ): Disposable
  registerRenameProvider(selector: DocumentSelector, provider: RenameProvider): Disposable
  registerWorkspaceSymbolProvider(provider: WorkspaceSymbolProvider): Disposable
  registerFoldingRangeProvider(
    selector: DocumentSelector,
    provider: FoldingRangeProvider,
  ): Disposable
  registerDocumentLinkProvider(
    selector: DocumentSelector,
    provider: DocumentLinkProvider,
  ): Disposable
  registerDocumentHighlightProvider(
    selector: DocumentSelector,
    provider: DocumentHighlightProvider,
  ): Disposable
  registerSelectionRangeProvider(
    selector: DocumentSelector,
    provider: SelectionRangeProvider,
  ): Disposable
  registerCodeActionsProvider(selector: DocumentSelector, provider: CodeActionProvider): Disposable
  registerDocumentFormattingEditProvider(
    selector: DocumentSelector,
    provider: DocumentFormattingEditProvider,
  ): Disposable
  registerDocumentRangeFormattingEditProvider(
    selector: DocumentSelector,
    provider: DocumentRangeFormattingEditProvider,
  ): Disposable
  registerOnTypeFormattingEditProvider(
    selector: DocumentSelector,
    provider: OnTypeFormattingEditProvider,
    triggerCharacters: readonly string[],
  ): Disposable
  registerInlayHintsProvider(selector: DocumentSelector, provider: InlayHintsProvider): Disposable
  registerDocumentSemanticTokensProvider(
    selector: DocumentSelector,
    provider: DocumentSemanticTokensProvider,
  ): Disposable
  registerCodeLensProvider(selector: DocumentSelector, provider: CodeLensProvider): Disposable
  createDiagnosticCollection(name?: string): DiagnosticCollection
  setLanguageServerStatus(id: string, status: LanguageServerStatus): void
  getLanguages(): Promise<string[]>
  getTextDocuments(): readonly TextDocument[]
  readonly onDidOpenTextDocument: Event<TextDocument>
  readonly onDidChangeTextDocument: Event<TextDocumentChangeEvent>
  readonly onDidCloseTextDocument: Event<TextDocument>
  readonly onWillSaveTextDocument: Event<WillSaveTextDocumentEvent>
  readonly onDidSaveTextDocument: Event<TextDocument>
  readonly onDidChangeConfiguration: Event<ConfigurationChangeEvent>
  /** The `ai` namespace. */
  readonly ai: AiApi
}

export function installApiBridge(bridge: IExtensionHostBridge): void {
  ;(globalThis as Record<string, unknown>)[BRIDGE_KEY] = bridge
}

function createInMemoryMemento(initial?: Record<string, unknown>): Memento {
  const store = new Map<string, unknown>(initial ? Object.entries(initial) : [])
  const get = <T>(key: string, defaultValue?: T): T | undefined => {
    const value = store.get(key)
    return value === undefined ? defaultValue : (value as T)
  }
  return {
    get: get as Memento['get'],
    update: (key, value) => {
      store.set(key, value)
      return Promise.resolve()
    },
  }
}

/**
 * A Memento backed by persistent storage. The whole state object is mirrored in
 * memory (loaded once, before activation, via `initial`) so `get` stays
 * synchronous; `update` mutates the mirror and flushes the entire object back
 * through `flush` (fire-and-forget — persistence races are harmless, last write
 * wins, and the in-memory value is always authoritative for this session).
 */
function createPersistentMemento(
  initial: Record<string, unknown>,
  flush: (state: Record<string, unknown>) => void,
): Memento {
  const store: Record<string, unknown> = { ...initial }
  const get = <T>(key: string, defaultValue?: T): T | undefined => {
    const value = store[key]
    return value === undefined ? defaultValue : (value as T)
  }
  return {
    get: get as Memento['get'],
    update: (key, value) => {
      if (value === undefined) delete store[key]
      else store[key] = value
      flush({ ...store })
      return Promise.resolve()
    },
  }
}

/**
 * Loads a JSON-encoded state object from the host storage RPC, tolerating a
 * missing key or malformed JSON (returns `{}` then).
 */
async function loadState(
  storage: IExtensionStorage,
  scope: ExtHostStorageScope,
  extId: string,
): Promise<Record<string, unknown>> {
  try {
    const json = await storage.$get(scope, extId)
    if (json === undefined) return {}
    const parsed: unknown = JSON.parse(json)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch (err) {
    console.error(
      `[ext-host] failed to load ${scope === 1 ? 'workspace' : 'global'} state for ${extId}:`,
      err,
    )
    return {}
  }
}

/**
 * Phase 3 context: subscriptions + path + persistent mementos. When no storage
 * backend is wired (tests), falls back to in-memory mementos so `activate` still
 * gets a working context.
 *
 * `globalStorageHome` (from the host env) is the parent of every extension's
 * private storage dir; the per-extension path is `<home>/<extId>`. Empty when
 * unconfigured, so extensions can detect "no persistent storage available".
 */
export async function createExtensionContext(
  ext: IScannedExtension,
  storage?: IExtensionStorage,
  globalStorageHome?: string,
): Promise<ExtensionContext> {
  const globalStoragePath = globalStorageHome ? join(globalStorageHome, ext.id) : ''
  if (!storage) {
    return {
      subscriptions: [],
      extensionPath: ext.extensionPath,
      globalStoragePath,
      globalState: createInMemoryMemento(),
      workspaceState: createInMemoryMemento(),
    }
  }
  const [globalInitial, workspaceInitial] = await Promise.all([
    loadState(storage, 0, ext.id),
    loadState(storage, 1, ext.id),
  ])
  return {
    subscriptions: [],
    extensionPath: ext.extensionPath,
    globalStoragePath,
    globalState: createPersistentMemento(globalInitial, (state) => {
      void storage.$set(0, ext.id, JSON.stringify(state))
    }),
    workspaceState: createPersistentMemento(workspaceInitial, (state) => {
      void storage.$set(1, ext.id, JSON.stringify(state))
    }),
  }
}
