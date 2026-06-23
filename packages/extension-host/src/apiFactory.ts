/**
 * Builds the runtime API injected into extensions. The single global bridge
 * (installed before any extension is imported) backs the `commands` namespace
 * of `@universe-editor/extension-api`; per-extension `ExtensionContext` objects
 * are created at activation time.
 */
import type {
  AiApi,
  CompletionItemProvider,
  DecorationRenderOptions,
  DefinitionProvider,
  DiagnosticCollection,
  Disposable,
  DocumentSelector,
  DocumentSymbolProvider,
  Event,
  ExtensionContext,
  FileStat,
  FileType,
  FoldingRangeProvider,
  HoverProvider,
  ImplementationProvider,
  InputBoxOptions,
  Memento,
  OutputChannel,
  QuickPickItem,
  QuickPickOptions,
  ReferenceProvider,
  RenameProvider,
  SignatureHelpProvider,
  SignatureHelpProviderMetadata,
  SourceControl,
  StatusBarAlignment,
  StatusBarItem,
  TextDocument,
  TextDocumentChangeEvent,
  TextEditor,
  TextEditorDecorationType,
  TypeDefinitionProvider,
  WorkspaceSymbolProvider,
} from '@universe-editor/extension-api'
import type { IScannedExtension } from './extensionScanner.js'
import type { ExtHostStorageScope, IMainThreadStorage } from '@universe-editor/extensions-common'

/** The slice of the storage RPC the context factory needs (whole-object get/set). */
export type IExtensionStorage = IMainThreadStorage

/**
 * Global key the bridge is installed under. KEEP IN SYNC with the consumer in
 * `packages/extension-api/src/index.ts` (same key, same method shapes).
 */
const BRIDGE_KEY = '__universeExtensionHostBridge__'

/** The bridge the extension-api delegates to. Matches `IExtensionHostBridge` there. */
export interface IExtensionHostBridge {
  registerCommand(command: string, handler: (...args: unknown[]) => unknown): Disposable
  executeCommand(command: string, args: unknown[]): Promise<unknown>
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
  createSourceControl(id: string, label: string, rootUri?: string): SourceControl
  getActiveTextEditor(): Promise<TextEditor | undefined>
  readonly onDidChangeActiveTextEditor: Event<TextEditor | undefined>
  createTextEditorDecorationType(options: DecorationRenderOptions): TextEditorDecorationType
  getWorkspaceRoot(): string | undefined
  fsReadFile(path: string): Promise<Uint8Array>
  fsWriteFile(path: string, content: Uint8Array): Promise<void>
  fsStat(path: string): Promise<FileStat>
  fsReadDirectory(path: string): Promise<[string, FileType][]>
  fsCreateDirectory(path: string): Promise<void>
  fsDelete(path: string, recursive: boolean): Promise<void>
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
  createDiagnosticCollection(name?: string): DiagnosticCollection
  getTextDocuments(): readonly TextDocument[]
  readonly onDidOpenTextDocument: Event<TextDocument>
  readonly onDidChangeTextDocument: Event<TextDocumentChangeEvent>
  readonly onDidCloseTextDocument: Event<TextDocument>
  /** The `ai` namespace — trusted-only; throws in a restricted host. */
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
 * backend is wired (restricted host probing, tests), falls back to in-memory
 * mementos so `activate` still gets a working context.
 */
export async function createExtensionContext(
  ext: IScannedExtension,
  storage?: IExtensionStorage,
): Promise<ExtensionContext> {
  if (!storage) {
    return {
      subscriptions: [],
      extensionPath: ext.extensionPath,
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
    globalState: createPersistentMemento(globalInitial, (state) => {
      void storage.$set(0, ext.id, JSON.stringify(state))
    }),
    workspaceState: createPersistentMemento(workspaceInitial, (state) => {
      void storage.$set(1, ext.id, JSON.stringify(state))
    }),
  }
}
