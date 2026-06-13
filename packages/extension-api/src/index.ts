/**
 * `@universe-editor/extension-api` — the surface plugin authors program against
 * (the Universe equivalent of `vscode.d.ts`). Its package version is the API
 * version: extensions declare a compatible range via `engines.universe`.
 *
 * This module is BUNDLED INTO each extension (esbuild inlines it). At run time
 * its namespaces delegate to a host-provided bridge installed on `globalThis`
 * by the extension host before any extension is imported — so plugins import
 * this module statically but every call is serviced by the host over RPC.
 */

import type { ScmApi, SourceControl } from './scm.js'
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

export * from './scm.js'

/** Re-exported LSP types that appear in language-provider signatures, so plugin
 *  authors get a self-contained API surface (the Universe equivalent of `vscode.d.ts`). */
export type {
  CompletionItem,
  CompletionList,
  Definition,
  DefinitionLink,
  Diagnostic,
  DocumentSymbol,
  FoldingRange,
  Hover,
  Location,
  LocationLink,
  MarkupContent,
  Position,
  Range,
  SignatureHelp,
  SymbolInformation,
  TextEdit,
  WorkspaceEdit,
  WorkspaceSymbol,
} from 'vscode-languageserver-types'

/** `FoldingRangeKind` is a value (its `Comment`/`Imports`/`Region` constants),
 *  so it re-exports separately from the type-only block above. */
export { FoldingRangeKind } from 'vscode-languageserver-types'

/** Semantic version of this API surface. The host checks `engines.universe`. */
export const version = '0.1.0'

export interface Disposable {
  dispose(): void
}

/** A subscribable signal: call with a listener, dispose to unsubscribe. */
export type Event<T> = (listener: (e: T) => void) => Disposable

/** Per-extension key/value store handed to `activate` via ExtensionContext. */
export interface Memento {
  get<T>(key: string): T | undefined
  get<T>(key: string, defaultValue: T): T
  update(key: string, value: unknown): Promise<void>
}

/** Passed to `activate`. Authors push disposables onto `subscriptions`. */
export interface ExtensionContext {
  readonly subscriptions: Disposable[]
  readonly extensionPath: string
  readonly globalState: Memento
  readonly workspaceState: Memento
}

export interface CommandsApi {
  /**
   * Register a handler for `command`. The returned Disposable unregisters it;
   * push it onto `context.subscriptions` so it is cleaned up on deactivate.
   */
  registerCommand(command: string, handler: (...args: unknown[]) => unknown): Disposable
  /** Execute any command (contributed or built-in) and await its result. */
  executeCommand<T = unknown>(command: string, ...args: unknown[]): Promise<T | undefined>
}

/** Where a status-bar item sits relative to the center. */
export enum StatusBarAlignment {
  Left = 0,
  Right = 1,
}

/**
 * A status-bar entry the extension owns. Property changes take effect once the
 * item is shown; call `show()` after setting `text`. Leading `$(icon)` syntax in
 * `text` renders an icon (e.g. `$(git-branch) main`).
 */
export interface StatusBarItem {
  text: string
  tooltip: string | undefined
  command: string | undefined
  /**
   * Render a spinner alongside the text while a background operation runs.
   * `true`/`'spinning'` → a loader; `'syncing'` → a rotating sync icon.
   */
  showProgress: boolean | 'spinning' | 'syncing' | undefined
  readonly alignment: StatusBarAlignment
  readonly priority: number
  show(): void
  hide(): void
  dispose(): void
}

export interface QuickPickOptions {
  placeHolder?: string
}

/** A richer quick-pick entry with secondary text. */
export interface QuickPickItem {
  label: string
  description?: string
  detail?: string
}

export interface InputBoxOptions {
  placeHolder?: string
  prompt?: string
  value?: string
}

/** A channel in the Output panel that an extension can write to. */
export interface OutputChannel extends Disposable {
  readonly name: string
  append(text: string): void
  appendLine(text: string): void
  clear(): void
  show(): void
}

/** The `window` namespace: UI surfaced through the host's renderer. */
export interface WindowApi {
  showInformationMessage(message: string, ...items: string[]): Promise<string | undefined>
  showWarningMessage(message: string, ...items: string[]): Promise<string | undefined>
  showErrorMessage(message: string, ...items: string[]): Promise<string | undefined>
  showQuickPick(items: readonly string[], options?: QuickPickOptions): Promise<string | undefined>
  showQuickPick<T extends QuickPickItem>(
    items: readonly T[],
    options?: QuickPickOptions,
  ): Promise<T | undefined>
  showInputBox(options?: InputBoxOptions): Promise<string | undefined>
  createStatusBarItem(alignment?: StatusBarAlignment, priority?: number): StatusBarItem
  createOutputChannel(name: string): OutputChannel
}

/** A text document open in the editor. URIs/positions are LSP-shaped. */
export interface TextDocument {
  readonly uri: UriComponents
  readonly languageId: string
  /** Monotonic version, bumped on every edit. */
  readonly version: number
  getText(): string
}

/** Fired by `onDidChangeTextDocument`. Full-text sync, so only the document is carried. */
export interface TextDocumentChangeEvent {
  readonly document: TextDocument
}

/** The `workspace` namespace: the folder the editor currently has open. */
export interface WorkspaceApi {
  /**
   * Absolute filesystem path of the open workspace folder, or undefined when no
   * folder is open. Fixed at extension-host startup (single-folder only).
   */
  readonly rootPath: string | undefined
  /**
   * Gated filesystem access. Every call is routed through the host's path policy
   * (denies sensitive locations, forbids escaping the workspace root) before
   * touching disk — the only filesystem an external/restricted extension gets.
   */
  readonly fs: FileSystemApi
  /** Documents currently open in the editor, mirrored from the renderer. */
  readonly textDocuments: readonly TextDocument[]
  readonly onDidOpenTextDocument: Event<TextDocument>
  readonly onDidChangeTextDocument: Event<TextDocumentChangeEvent>
  readonly onDidCloseTextDocument: Event<TextDocument>
  /**
   * Read configuration values. `section` is an optional key prefix (e.g. `'git'`),
   * so `getConfiguration('git').get('autofetch', true)` reads `git.autofetch`.
   */
  getConfiguration(section?: string): WorkspaceConfiguration
}

/** Kind of a filesystem entry returned by {@link FileSystemApi}. */
export enum FileType {
  File = 1,
  Directory = 2,
}

export interface FileStat {
  readonly type: FileType
  readonly size: number
  /** Last-modified time, epoch milliseconds. */
  readonly mtime: number
}

/** A minimal, gated filesystem — the subset of `vscode.workspace.fs` we support. */
export interface FileSystemApi {
  readFile(path: string): Promise<Uint8Array>
  writeFile(path: string, content: Uint8Array): Promise<void>
  stat(path: string): Promise<FileStat>
  readDirectory(path: string): Promise<[string, FileType][]>
  createDirectory(path: string): Promise<void>
  delete(path: string, options?: { recursive?: boolean }): Promise<void>
}

/** Read-only view over a configuration section (async — values live in the renderer). */
export interface WorkspaceConfiguration {
  get<T>(key: string, defaultValue: T): Promise<T>
}

/** Structural URI matching the editor's `UriComponents`; JSON-serializable so it
 *  crosses the host RPC verbatim. */
export interface UriComponents {
  scheme: string
  authority?: string
  path?: string
  query?: string
  fragment?: string
}

/** A provider result may be sync or async, and may be absent. */
export type ProviderResult<T> = T | null | undefined | Promise<T | null | undefined>

/** Language ids a provider applies to (e.g. `'typescript'` or `['typescript','javascript']`). */
export type DocumentSelector = string | readonly string[]

export interface DefinitionProvider {
  provideDefinition(
    document: TextDocument,
    position: Position,
  ): ProviderResult<Definition | DefinitionLink[]>
}

export interface ReferenceContext {
  readonly includeDeclaration: boolean
}

export interface ReferenceProvider {
  provideReferences(
    document: TextDocument,
    position: Position,
    context: ReferenceContext,
  ): ProviderResult<Location[]>
}

export interface ImplementationProvider {
  provideImplementation(
    document: TextDocument,
    position: Position,
  ): ProviderResult<Definition | DefinitionLink[]>
}

export interface TypeDefinitionProvider {
  provideTypeDefinition(
    document: TextDocument,
    position: Position,
  ): ProviderResult<Definition | DefinitionLink[]>
}

export interface HoverProvider {
  provideHover(document: TextDocument, position: Position): ProviderResult<Hover>
}

/** How a completion was triggered (mirrors LSP `CompletionTriggerKind`). */
export interface CompletionContext {
  readonly triggerKind: 1 | 2 | 3
  readonly triggerCharacter?: string
}

export interface CompletionItemProvider {
  provideCompletionItems(
    document: TextDocument,
    position: Position,
    context: CompletionContext,
  ): ProviderResult<CompletionItem[] | CompletionList>
  resolveCompletionItem?(item: CompletionItem): ProviderResult<CompletionItem>
}

/** How a signature-help session was triggered (mirrors LSP `SignatureHelpContext`). */
export interface SignatureHelpContext {
  readonly triggerKind: 1 | 2 | 3
  readonly triggerCharacter?: string
  readonly isRetrigger: boolean
}

export interface SignatureHelpProvider {
  provideSignatureHelp(
    document: TextDocument,
    position: Position,
    context: SignatureHelpContext,
  ): ProviderResult<SignatureHelp>
}

export interface SignatureHelpProviderMetadata {
  readonly triggerCharacters: readonly string[]
  readonly retriggerCharacters: readonly string[]
}

export interface DocumentSymbolProvider {
  provideDocumentSymbols(
    document: TextDocument,
  ): ProviderResult<DocumentSymbol[] | SymbolInformation[]>
}

export interface RenameProvider {
  provideRenameEdits(
    document: TextDocument,
    position: Position,
    newName: string,
  ): ProviderResult<WorkspaceEdit>
}

export interface WorkspaceSymbolProvider {
  provideWorkspaceSymbols(query: string): ProviderResult<WorkspaceSymbol[] | SymbolInformation[]>
}

export interface FoldingRangeProvider {
  provideFoldingRanges(document: TextDocument): ProviderResult<FoldingRange[]>
}

/**
 * Owns a set of diagnostics surfaced as editor markers. `set` replaces a URI's
 * diagnostics (or clears it with `undefined`); the collection name is the marker
 * owner, so multiple providers can mark the same file without clobbering.
 */
export interface DiagnosticCollection {
  readonly name: string
  set(uri: UriComponents, diagnostics: readonly Diagnostic[] | undefined): void
  delete(uri: UriComponents): void
  clear(): void
  dispose(): void
}

/** The `languages` namespace: register language feature providers with the editor. */
export interface LanguagesApi {
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
    ...triggerCharacters: string[]
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
}

/**
 * The host bridge contract installed on globalThis. KEEP IN SYNC with the
 * producer in `extension-host/src/apiFactory.ts` (same key, same shapes).
 */
interface IExtensionHostBridge {
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
}

/** Global key the host installs the bridge under. KEEP IN SYNC with the host. */
const BRIDGE_KEY = '__universeExtensionHostBridge__'

function bridge(): IExtensionHostBridge {
  const b = (globalThis as Record<string, unknown>)[BRIDGE_KEY] as IExtensionHostBridge | undefined
  if (!b) {
    throw new Error('Universe extension API used outside the extension host')
  }
  return b
}

export const commands: CommandsApi = {
  registerCommand: (command, handler) => bridge().registerCommand(command, handler),
  executeCommand: <T = unknown>(command: string, ...args: unknown[]) =>
    bridge().executeCommand(command, args) as Promise<T | undefined>,
}

export const window: WindowApi = {
  showInformationMessage: (message, ...items) => bridge().showMessage('info', message, items),
  showWarningMessage: (message, ...items) => bridge().showMessage('warning', message, items),
  showErrorMessage: (message, ...items) => bridge().showMessage('error', message, items),
  showQuickPick: ((items: readonly (string | QuickPickItem)[], options?: QuickPickOptions) =>
    bridge().showQuickPick(items, options)) as WindowApi['showQuickPick'],
  showInputBox: (options) => bridge().showInputBox(options),
  createStatusBarItem: (alignment = StatusBarAlignment.Left, priority = 0) =>
    bridge().createStatusBarItem(alignment, priority),
  createOutputChannel: (name) => bridge().createOutputChannel(name),
}

export const scm: ScmApi = {
  createSourceControl: (id, label, rootUri) => bridge().createSourceControl(id, label, rootUri),
}

export const languages: LanguagesApi = {
  registerDefinitionProvider: (selector, provider) =>
    bridge().registerDefinitionProvider(selector, provider),
  registerReferenceProvider: (selector, provider) =>
    bridge().registerReferenceProvider(selector, provider),
  registerImplementationProvider: (selector, provider) =>
    bridge().registerImplementationProvider(selector, provider),
  registerTypeDefinitionProvider: (selector, provider) =>
    bridge().registerTypeDefinitionProvider(selector, provider),
  registerHoverProvider: (selector, provider) => bridge().registerHoverProvider(selector, provider),
  registerCompletionItemProvider: (selector, provider, ...triggerCharacters) =>
    bridge().registerCompletionItemProvider(selector, provider, triggerCharacters),
  registerSignatureHelpProvider: (selector, provider, metadata) =>
    bridge().registerSignatureHelpProvider(selector, provider, metadata),
  registerDocumentSymbolProvider: (selector, provider) =>
    bridge().registerDocumentSymbolProvider(selector, provider),
  registerRenameProvider: (selector, provider) =>
    bridge().registerRenameProvider(selector, provider),
  registerWorkspaceSymbolProvider: (provider) => bridge().registerWorkspaceSymbolProvider(provider),
  registerFoldingRangeProvider: (selector, provider) =>
    bridge().registerFoldingRangeProvider(selector, provider),
  createDiagnosticCollection: (name) => bridge().createDiagnosticCollection(name),
}

export const workspace: WorkspaceApi = {
  get rootPath() {
    return bridge().getWorkspaceRoot()
  },
  fs: {
    readFile: (path) => bridge().fsReadFile(path),
    writeFile: (path, content) => bridge().fsWriteFile(path, content),
    stat: (path) => bridge().fsStat(path),
    readDirectory: (path) => bridge().fsReadDirectory(path),
    createDirectory: (path) => bridge().fsCreateDirectory(path),
    delete: (path, options) => bridge().fsDelete(path, options?.recursive ?? false),
  },
  get textDocuments() {
    return bridge().getTextDocuments()
  },
  onDidOpenTextDocument: (listener) => bridge().onDidOpenTextDocument(listener),
  onDidChangeTextDocument: (listener) => bridge().onDidChangeTextDocument(listener),
  onDidCloseTextDocument: (listener) => bridge().onDidCloseTextDocument(listener),
  getConfiguration: (section) => ({
    get: <T>(key: string, defaultValue: T): Promise<T> =>
      bridge().getConfiguration(section, key, defaultValue) as Promise<T>,
  }),
}
