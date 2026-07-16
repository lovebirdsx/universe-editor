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
import type { CustomEditorOptions, CustomReadonlyEditorProvider } from './webview.js'
import type {
  CompletionItem,
  CompletionList,
  CodeAction,
  CodeLens,
  Definition,
  DefinitionLink,
  Diagnostic,
  DocumentHighlight,
  DocumentLink,
  DocumentSymbol,
  FoldingRange,
  Hover,
  Location,
  Position,
  Range,
  SelectionRange,
  SemanticTokens,
  SemanticTokensLegend,
  SignatureHelp,
  SymbolInformation,
  TextEdit,
  WorkspaceEdit,
  WorkspaceSymbol,
} from 'vscode-languageserver-types'

export * from './scm.js'
export * from './webview.js'

/** Re-exported LSP types that appear in language-provider signatures, so plugin
 *  authors get a self-contained API surface (the Universe equivalent of `vscode.d.ts`). */
export type {
  CompletionItem,
  CompletionList,
  CodeAction,
  CodeLens,
  Definition,
  DefinitionLink,
  Diagnostic,
  DocumentHighlight,
  DocumentLink,
  DocumentSymbol,
  FoldingRange,
  Hover,
  Location,
  LocationLink,
  MarkupContent,
  Position,
  Range,
  SelectionRange,
  SemanticTokens,
  SemanticTokensLegend,
  SignatureHelp,
  SymbolInformation,
  TextEdit,
  WorkspaceEdit,
  WorkspaceSymbol,
} from 'vscode-languageserver-types'

/** `FoldingRangeKind` is a value (its `Comment`/`Imports`/`Region` constants),
 *  so it re-exports separately from the type-only block above. */
export { FoldingRangeKind } from 'vscode-languageserver-types'

/** Semantic version of this API surface. The host checks `engines.universe`.
 *  Bumping this is governed by COMPATIBILITY.md — keep it in sync with the
 *  package.json version and the contract test's frozen snapshot. */
export const version = '0.4.0'

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
  /**
   * An extension-private directory (`<globalStorageHome>/<extId>`) for caching
   * large data across sessions. Persists globally (all workspaces). The parent
   * exists; the extension creates this directory on first write. Empty string
   * when no storage home is configured (restricted-host probing, tests).
   */
  readonly globalStoragePath: string
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
  iconId?: string
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
  /** The focused text editor, or undefined when no editor has focus. A snapshot —
   *  re-fetch after an external change rather than holding the handle long-term. */
  getActiveTextEditor(): Promise<TextEditor | undefined>
  /** Fires when the focused text editor changes; argument is undefined when focus
   *  leaves all text editors. The editor is a fresh snapshot, as from
   *  {@link WindowApi.getActiveTextEditor}. */
  readonly onDidChangeActiveTextEditor: Event<TextEditor | undefined>
  /** Create a reusable decoration style for {@link TextEditor.setDecorations}. */
  createTextEditorDecorationType(options: DecorationRenderOptions): TextEditorDecorationType
  /**
   * Register a webview-backed custom editor for `viewType`. The `viewType` must
   * match a `contributes.customEditors[].viewType` entry so the workbench knows
   * which files route here. The workbench owns the editor tab + webview iframe
   * and calls the provider's `resolveCustomEditor` for each opened resource.
   */
  registerCustomEditorProvider(
    viewType: string,
    provider: CustomReadonlyEditorProvider,
    options?: CustomEditorOptions,
  ): Disposable
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

/** Why a document is being saved. Mirrors VSCode's `TextDocumentSaveReason`. */
export enum TextDocumentSaveReason {
  /** Manually triggered, e.g. by the user pressing save. */
  Manual = 1,
  /** Automatic after a delay. */
  AfterDelay = 2,
  /** When the editor lost focus. */
  FocusOut = 3,
}

/**
 * Fired by `onWillSaveTextDocument` before a document is written to disk. A
 * listener may contribute edits applied prior to the save by calling
 * `waitUntil` with a promise of {@link TextEdit}s — the save waits for it (up to
 * a host-imposed timeout). This is how ESLint's fix-all-on-save works.
 */
export interface WillSaveTextDocumentEvent {
  readonly document: TextDocument
  readonly reason: TextDocumentSaveReason
  /** Delay the save until `thenable` resolves, then apply its edits to the
   *  document. Multiple listeners' edits are applied in registration order. */
  waitUntil(thenable: Promise<TextEdit[]>): void
}

/** A selection in a {@link TextEditor}. `anchor` is the fixed end, `active` the
 *  moving end (where the cursor is); they're equal for an empty selection. */
export interface Selection {
  readonly anchor: Position
  readonly active: Position
}

/** Edit builder handed to {@link TextEditor.edit}; collected edits apply as one
 *  undo step. Coordinates are LSP-shaped (0-based), as everywhere in this API. */
export interface TextEditorEdit {
  replace(range: Range, text: string): void
  insert(position: Position, text: string): void
  delete(range: Range): void
}

/**
 * A handle to a text editor open in the workbench. Returned by
 * {@link WindowApi.getActiveTextEditor} as a snapshot: `document` and
 * `selections` reflect the editor at the moment it was fetched, while `edit`
 * and `setSelections` drive the live editor (an edit fails if its content
 * changed underneath in the meantime).
 */
export interface TextEditor {
  readonly document: TextDocument
  /** All selections; the primary one is `selections[0]`. Never empty. */
  readonly selections: readonly Selection[]
  /** Convenience for `selections[0]` — the primary selection. */
  readonly selection: Selection
  /** Apply edits as a single undo step. Resolves false if the document moved on. */
  edit(callback: (editBuilder: TextEditorEdit) => void): Promise<boolean>
  /** Replace the selections and reveal the primary one. */
  setSelections(selections: readonly Selection[]): Promise<void>
  /**
   * Paint `ranges` with a decoration type in this editor, replacing any ranges
   * previously set for that type. Pass an empty array to clear it. The
   * decoration persists on the editor until replaced or the type is disposed.
   */
  setDecorations(decorationType: TextEditorDecorationType, ranges: readonly Range[]): void
}

/** Where a decoration shows in the overview ruler (mirrors VSCode's enum). */
export enum OverviewRulerLane {
  Left = 1,
  Center = 2,
  Right = 4,
  Full = 7,
}

/**
 * The visual styling of a decoration type. `gutterIconPath` is a data-URI (an
 * inline SVG, typically) painted in the editor's glyph margin; the color/border
 * fields style the line itself. Fixed at creation — to restyle, dispose and
 * recreate.
 */
export interface DecorationRenderOptions {
  /** Data-URI of an icon painted in the glyph margin (gutter). */
  gutterIconPath?: string
  /** Apply the line styling to the whole line, not just the decorated range. */
  isWholeLine?: boolean
  backgroundColor?: string
  borderColor?: string
  borderWidth?: string
  overviewRulerColor?: string
  overviewRulerLane?: OverviewRulerLane
}

/**
 * A reusable decoration style created by {@link WindowApi.createTextEditorDecorationType}
 * and applied via {@link TextEditor.setDecorations}. Dispose to remove every
 * decoration painted with it.
 */
export interface TextEditorDecorationType extends Disposable {
  /** Opaque id allocated by the host; identifies this type across the RPC wire. */
  readonly key: number
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
   * Fires before a text document is saved. A listener may call
   * `event.waitUntil(Promise<TextEdit[]>)` to contribute edits applied before the
   * save (bounded by a host timeout). Used for save-time fixups like ESLint.
   */
  readonly onWillSaveTextDocument: Event<WillSaveTextDocumentEvent>
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

export interface DocumentLinkProvider {
  provideDocumentLinks(document: TextDocument): ProviderResult<DocumentLink[]>
  /** Fill in a link's `target` lazily; Monaco calls this just before navigating. */
  resolveDocumentLink?(link: DocumentLink): ProviderResult<DocumentLink>
}

export interface DocumentHighlightProvider {
  provideDocumentHighlights(
    document: TextDocument,
    position: Position,
  ): ProviderResult<DocumentHighlight[]>
}

export interface SelectionRangeProvider {
  provideSelectionRanges(
    document: TextDocument,
    positions: Position[],
  ): ProviderResult<SelectionRange[]>
}

/** What triggered a code-action request. Mirrors LSP `CodeActionContext` (kinds only). */
export interface CodeActionContext {
  readonly only?: readonly string[]
}

export interface CodeActionProvider {
  provideCodeActions(
    document: TextDocument,
    range: Range,
    context: CodeActionContext,
  ): ProviderResult<CodeAction[]>
}

/** Options a formatter receives (mirrors LSP `FormattingOptions`: the two fields
 *  every provider gets — the editor's indentation settings for the document). */
export interface FormattingOptions {
  readonly tabSize: number
  readonly insertSpaces: boolean
}

export interface DocumentFormattingEditProvider {
  provideDocumentFormattingEdits(
    document: TextDocument,
    options: FormattingOptions,
  ): ProviderResult<TextEdit[]>
}

/**
 * Whole-document semantic tokens. `legend` names the numeric token-type /
 * modifier indices encoded in `SemanticTokens.data`; it's returned to Monaco
 * synchronously at registration, so the provider carries it as a field.
 */
export interface DocumentSemanticTokensProvider {
  readonly legend: SemanticTokensLegend
  provideDocumentSemanticTokens(document: TextDocument): ProviderResult<SemanticTokens>
}

/**
 * Provides CodeLenses — actionable annotations (e.g. "3 references") rendered
 * above a line. Two-phase like completion: `provideCodeLenses` returns lenses
 * with ranges (command optional), and Monaco calls `resolveCodeLens` lazily to
 * fill in each lens's `command` only for the ones actually shown. Fire
 * `onDidChangeCodeLenses` to make the editor re-request lenses (e.g. after a
 * config change or a workspace edit that shifts reference counts).
 */
export interface CodeLensProvider {
  onDidChangeCodeLenses?: Event<void>
  provideCodeLenses(document: TextDocument): ProviderResult<CodeLens[]>
  resolveCodeLens?(codeLens: CodeLens): ProviderResult<CodeLens>
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

/** Role of a message in an AI conversation. Matches the platform's numeric enum. */
export enum AiMessageRole {
  System = 0,
  User = 1,
  Assistant = 2,
}

/** A single message in an AI request. Text content only for now. */
export interface AiMessage {
  readonly role: AiMessageRole
  readonly content: string
}

/** Per-request options. `modelId` is required; the rest fall back to user config. */
export interface AiRequestOptions {
  readonly modelId: string
  readonly temperature?: number
  readonly maxTokens?: number
  readonly stop?: readonly string[]
  /** Feature/extension attribution shown in the AI debug recorder. */
  readonly purpose?: 'chat' | 'inline-completion' | 'session-title' | 'commit' | 'extension'
  /** Free-form sub-label (e.g. an extension id) shown alongside the purpose. */
  readonly debugLabel?: string
}

/** Self-describing model metadata, so an extension can pick a model by capability. */
export interface AiModelMetadata {
  readonly id: string
  readonly vendor: string
  readonly name: string
  readonly family: string
  readonly version?: string
  readonly maxInputTokens: number
  readonly maxOutputTokens: number
  readonly capabilities: {
    readonly streaming: boolean
    readonly vision?: boolean
    readonly toolCalling?: boolean
  }
}

/** Pick a model by condition instead of hardcoding an id. */
export interface AiModelSelector {
  readonly vendor?: string
  readonly family?: string
  readonly id?: string
}

/** Smallest unit of a streamed response. */
export type AiResponseChunk =
  | { readonly type: 'text'; readonly value: string }
  | { readonly type: 'usage'; readonly inputTokens: number; readonly outputTokens: number }

/**
 * A streamed AI response. Iterate `stream` for chunks as they arrive; await
 * `result` for completion (rejects on failure). Call `cancel()` to abort — it
 * propagates across the process boundary and stops the underlying network call.
 */
export interface AiResponse {
  readonly stream: AsyncIterable<AiResponseChunk>
  readonly result: Promise<void>
  cancel(): void
}

/**
 * The `ai` namespace: inference models and streaming requests. Trusted (built-in)
 * extensions only; restricted (external) extensions cannot reach AI models.
 */
export interface AiApi {
  getModels(): Promise<readonly AiModelMetadata[]>
  selectModels(selector: AiModelSelector): Promise<readonly string[]>
  computeTokenLength(modelId: string, text: string): Promise<number>
  /** The user's currently selected chat model id (UI state), if any. */
  getActiveModelId(): Promise<string | undefined>
  /** The user's currently selected commit-message model id, if any. */
  getCommitModelId(): Promise<string | undefined>
  /** Send a request and stream the response. Cancel via the returned handle. */
  sendRequest(messages: readonly AiMessage[], options: AiRequestOptions): AiResponse
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
  registerDocumentSemanticTokensProvider(
    selector: DocumentSelector,
    provider: DocumentSemanticTokensProvider,
  ): Disposable
  registerCodeLensProvider(selector: DocumentSelector, provider: CodeLensProvider): Disposable
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
  getActiveTextEditor(): Promise<TextEditor | undefined>
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
  readonly onDidChangeActiveTextEditor: Event<TextEditor | undefined>
  createTextEditorDecorationType(options: DecorationRenderOptions): TextEditorDecorationType
  registerCustomEditorProvider(
    viewType: string,
    provider: CustomReadonlyEditorProvider,
    options?: CustomEditorOptions,
  ): Disposable
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
  registerDocumentSemanticTokensProvider(
    selector: DocumentSelector,
    provider: DocumentSemanticTokensProvider,
  ): Disposable
  registerCodeLensProvider(selector: DocumentSelector, provider: CodeLensProvider): Disposable
  createDiagnosticCollection(name?: string): DiagnosticCollection
  getTextDocuments(): readonly TextDocument[]
  readonly onDidOpenTextDocument: Event<TextDocument>
  readonly onDidChangeTextDocument: Event<TextDocumentChangeEvent>
  readonly onDidCloseTextDocument: Event<TextDocument>
  readonly onWillSaveTextDocument: Event<WillSaveTextDocumentEvent>
  readonly ai: AiApi
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
  getActiveTextEditor: () => bridge().getActiveTextEditor(),
  onDidChangeActiveTextEditor: (listener) => bridge().onDidChangeActiveTextEditor(listener),
  createTextEditorDecorationType: (options) => bridge().createTextEditorDecorationType(options),
  registerCustomEditorProvider: (viewType, provider, options) =>
    bridge().registerCustomEditorProvider(viewType, provider, options),
}

export const scm: ScmApi = {
  createSourceControl: (id, label, rootUri) => bridge().createSourceControl(id, label, rootUri),
}

export const ai: AiApi = {
  getModels: () => bridge().ai.getModels(),
  selectModels: (selector) => bridge().ai.selectModels(selector),
  computeTokenLength: (modelId, text) => bridge().ai.computeTokenLength(modelId, text),
  getActiveModelId: () => bridge().ai.getActiveModelId(),
  getCommitModelId: () => bridge().ai.getCommitModelId(),
  sendRequest: (messages, options) => bridge().ai.sendRequest(messages, options),
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
  registerDocumentLinkProvider: (selector, provider) =>
    bridge().registerDocumentLinkProvider(selector, provider),
  registerDocumentHighlightProvider: (selector, provider) =>
    bridge().registerDocumentHighlightProvider(selector, provider),
  registerSelectionRangeProvider: (selector, provider) =>
    bridge().registerSelectionRangeProvider(selector, provider),
  registerCodeActionsProvider: (selector, provider) =>
    bridge().registerCodeActionsProvider(selector, provider),
  registerDocumentFormattingEditProvider: (selector, provider) =>
    bridge().registerDocumentFormattingEditProvider(selector, provider),
  registerDocumentSemanticTokensProvider: (selector, provider) =>
    bridge().registerDocumentSemanticTokensProvider(selector, provider),
  registerCodeLensProvider: (selector, provider) =>
    bridge().registerCodeLensProvider(selector, provider),
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
  onWillSaveTextDocument: (listener) => bridge().onWillSaveTextDocument(listener),
  getConfiguration: (section) => ({
    get: <T>(key: string, defaultValue: T): Promise<T> =>
      bridge().getConfiguration(section, key, defaultValue) as Promise<T>,
  }),
}
