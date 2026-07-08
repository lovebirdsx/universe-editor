/**
 * Wire-level contract shared by all three processes:
 *   renderer (MainThread*) ↔ main (byte pipe) ↔ extension host (ExtHost*).
 *
 * The renderer and the extension host each run a ChannelServer + ChannelClient
 * over the same stdio protocol; these names key the channels on both ends.
 *   - ExtHost* channels live on the host's ChannelServer; the renderer calls them.
 *   - MainThread* channels live on the renderer's ChannelServer; the host calls them.
 *
 * Method names are dispatched verbatim by ProxyChannel; the `$` prefix marks
 * RPC-only surface that never appears in the public extension API.
 */
import type { UriComponents } from '@universe-editor/platform'
import type {
  CompletionItem,
  CompletionList,
  CodeAction,
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
  SignatureHelp,
  SymbolInformation,
  WorkspaceEdit,
  WorkspaceSymbol,
} from 'vscode-languageserver-types'
import type { IExtensionDescriptionDto } from './manifest.js'

export const ExtHostChannels = {
  /** Renderer → ext host: execute a contributed command. */
  extHostCommands: 'extHostCommands',
  /** Renderer → ext host: enumerate contributions, drive activation. */
  extHostExtensions: 'extHostExtensions',
  /** Ext host → renderer: register/unregister commands an extension created at runtime. */
  mainThreadCommands: 'mainThreadCommands',
  /** Ext host → renderer: `window.*` UI (messages, quick input, status bar). */
  mainThreadWindow: 'mainThreadWindow',
  /** Ext host → renderer: the SCM model feeding the built-in source-control view. */
  mainThreadScm: 'mainThreadScm',
  /** Renderer → ext host: SCM view interactions (commit-box edits). */
  extHostScm: 'extHostScm',
  /** Ext host → renderer: gated filesystem access (path policy + IFileService). */
  mainThreadFs: 'mainThreadFs',
  /** Ext host → renderer: output channels shown in the Output panel. */
  mainThreadOutput: 'mainThreadOutput',
  /** Renderer → ext host: language `provide*` requests routed to a plugin's registered providers. */
  extHostLanguages: 'extHostLanguages',
  /** Renderer → ext host: text document open/change/close mirrored to the host's TextDocument model. */
  extHostDocuments: 'extHostDocuments',
  /** Ext host → renderer: provider registration + diagnostics fed into the editor. */
  mainThreadLanguages: 'mainThreadLanguages',
  /** Ext host → renderer: active text editor inspection + edits/selection control. */
  mainThreadEditor: 'mainThreadEditor',
  /** Renderer → ext host: active-editor changes mirrored to drive `onDidChangeActiveTextEditor`. */
  extHostEditor: 'extHostEditor',
  /** Trusted ext host → renderer: AI model requests (streaming chunks + cancel). */
  mainThreadAi: 'mainThreadAi',
  /** Ext host → renderer: persisted key/value storage backing `context.workspaceState`/`globalState`. */
  mainThreadStorage: 'mainThreadStorage',
  /** Ext host → renderer: custom-editor provider registration + webview panel control (html/options/postMessage). */
  mainThreadWebviews: 'mainThreadWebviews',
  /** Renderer → ext host: custom-editor resolution + webview message/lifecycle callbacks. */
  extHostWebviews: 'extHostWebviews',
} as const

export type ExtHostChannelName = (typeof ExtHostChannels)[keyof typeof ExtHostChannels]

/**
 * Ext host → exposed to the renderer (host's ChannelServer). The renderer's
 * ChannelClient calls these.
 */
export interface IExtHostCommands {
  /**
   * Run a command contributed by an activated extension and return its result.
   * Routed to the per-extension handler registered during `activate`.
   */
  $executeContributedCommand(id: string, args: unknown[]): Promise<unknown>
}

/** Ext host → exposed to the renderer: contribution enumeration + activation. */
export interface IExtHostExtensions {
  /** All scanned extensions' static contributions, for the renderer to translate. */
  $getContributions(): Promise<IExtensionDescriptionDto[]>
  /**
   * Activate every extension whose `activationEvents` match `event`. Resolves
   * once all matched extensions have finished `activate` (errors are isolated
   * per extension and logged to stderr, never rejecting the whole batch).
   */
  $activateByEvent(event: string): Promise<void>
}

/**
 * Renderer → exposed to the ext host (renderer's ChannelServer). The host's
 * ChannelClient calls these when an extension registers/unregisters a command
 * at runtime (i.e. one not already known from its manifest).
 */
export interface IMainThreadCommands {
  $registerCommand(id: string): Promise<void>
  $unregisterCommand(id: string): Promise<void>
  /**
   * Run a renderer-side built-in command (host → renderer direction). Used when
   * an extension's `commands.executeCommand` targets a command the host doesn't
   * own — e.g. `_workbench.openDiff`. The renderer rejects re-entry into
   * extension-contributed commands to avoid host↔renderer loops.
   */
  $executeCommand(id: string, args: unknown[]): Promise<unknown>
}

/** Severity for `window.show{Information,Warning,Error}Message`. */
export type ExtHostMessageSeverity = 'info' | 'warning' | 'error'

export interface IExtHostQuickPickOptions {
  placeHolder?: string
}

export interface IExtHostQuickPickItemDto {
  label: string
  description?: string
  detail?: string
  iconId?: string
}

export interface IExtHostInputBoxOptions {
  placeHolder?: string
  prompt?: string
  value?: string
}

/** Status-bar entry payload. `alignment`: 0 = Left, 1 = Right (platform convention). */
export interface IExtHostStatusBarEntryDto {
  text: string
  tooltip?: string
  command?: string
  alignment: number
  priority: number
  showProgress?: boolean | 'spinning' | 'syncing'
}

/**
 * Renderer → exposed to the ext host: the `window.*` namespace. Backs messages,
 * quick input and status-bar items an extension creates programmatically.
 * Status-bar items are keyed by a host-allocated `handle`.
 */
export interface IMainThreadWindow {
  /** Show a notification; with `items`, resolve to the picked label (or undefined). */
  $showMessage(
    severity: ExtHostMessageSeverity,
    message: string,
    items: string[],
  ): Promise<string | undefined>
  /**
   * Show a quick pick of plain strings or rich items; resolves to the selected
   * entry's index in `items` (or undefined when dismissed). The caller maps the
   * index back to its original item.
   */
  $showQuickPick(
    items: Array<string | IExtHostQuickPickItemDto>,
    options?: IExtHostQuickPickOptions,
  ): Promise<number | undefined>
  $showInputBox(options?: IExtHostInputBoxOptions): Promise<string | undefined>
  /** Create or update the status-bar entry for `handle`. */
  $setStatusBarEntry(handle: number, entry: IExtHostStatusBarEntryDto): Promise<void>
  $disposeStatusBarEntry(handle: number): Promise<void>
}

/** A filesystem entry's kind. Mirrors the subset of `IFileStat` extensions need. */
export type ExtHostFileType = 'file' | 'dir'

export interface IExtHostFileStatDto {
  readonly type: ExtHostFileType
  readonly size: number
  readonly mtime: number
}

/**
 * Renderer → exposed to the ext host: gated filesystem access backing
 * `workspace.fs`. Every call passes through the renderer's path policy
 * (denies `.ssh`/`.aws`/`.env`…, forbids escaping the workspace root) before
 * delegating to `IFileService`. File contents cross the wire as base64 strings —
 * the newline-delimited JSON framing can't carry raw `Uint8Array`.
 */
export interface IMainThreadFs {
  /** Read a file; returns its bytes base64-encoded. */
  $readFile(path: string): Promise<string>
  /** Write a file from base64-encoded bytes. */
  $writeFile(path: string, base64: string): Promise<void>
  $stat(path: string): Promise<IExtHostFileStatDto>
  $readDirectory(path: string): Promise<Array<[name: string, type: ExtHostFileType]>>
  $createDirectory(path: string): Promise<void>
  $delete(path: string, recursive: boolean): Promise<void>
}

/**
 * Renderer → exposed to the ext host: output channels shown in the Output panel.
 * The host allocates handles; the renderer creates/manages the actual channels.
 */
export interface IMainThreadOutput {
  $registerOutputChannel(handle: number, name: string): Promise<void>
  $append(handle: number, text: string): Promise<void>
  $clearOutputChannel(handle: number): Promise<void>
  $showOutputChannel(handle: number): Promise<void>
  $disposeOutputChannel(handle: number): Promise<void>
}

/**
 * The kinds of language feature a plugin can register. Crosses the wire as a
 * plain string; the renderer's MainThreadLanguages uses it to pick the right
 * Monaco provider factory.
 */
export type LanguageProviderType =
  | 'definition'
  | 'references'
  | 'implementation'
  | 'typeDefinition'
  | 'hover'
  | 'completion'
  | 'signatureHelp'
  | 'documentSymbol'
  | 'rename'
  | 'workspaceSymbol'
  | 'foldingRange'
  | 'documentLink'
  | 'documentHighlight'
  | 'selectionRange'
  | 'codeAction'

/** Language ids a provider applies to. Empty for workspace-wide providers. */
export type DocumentSelector = readonly string[]

/** Extra registration data Monaco needs up front (trigger characters). */
export interface ILanguageProviderMetadata {
  readonly triggerCharacters?: readonly string[]
  readonly signatureHelpTriggerCharacters?: readonly string[]
  readonly signatureHelpRetriggerCharacters?: readonly string[]
}

export interface IReferenceContext {
  readonly includeDeclaration: boolean
}

/** Mirrors LSP `CompletionContext` (triggerKind 1 = invoked, 2 = char, 3 = re-trigger). */
export interface ICompletionContext {
  readonly triggerKind: 1 | 2 | 3
  readonly triggerCharacter?: string
}

/** Mirrors LSP `SignatureHelpContext`. */
export interface ISignatureHelpContext {
  readonly triggerKind: 1 | 2 | 3
  readonly triggerCharacter?: string
  readonly isRetrigger: boolean
}

/**
 * Code-action request context. Only the requested kinds cross the wire; the
 * markdown server recomputes diagnostics itself (the marker → diagnostic round
 * trip drops the `data` quick-fixes depend on), so no diagnostics are sent.
 */
export interface ICodeActionContext {
  readonly only?: readonly string[]
}

/**
 * Renderer → exposed to the ext host: language `provide*` requests routed to the
 * providers a plugin registered via `languages.register*Provider`, addressed by
 * the host-allocated `handle`. The renderer's Monaco provider shells call these;
 * the host dispatches to the owning plugin handler. Positions are LSP 0-based;
 * URIs cross as `UriComponents`, so LSP results return verbatim with no
 * conversion on the wire.
 */
export interface IExtHostLanguages {
  $provideDefinition(
    handle: number,
    uri: UriComponents,
    position: Position,
  ): Promise<Definition | DefinitionLink[] | null>
  $provideReferences(
    handle: number,
    uri: UriComponents,
    position: Position,
    context: IReferenceContext,
  ): Promise<Location[] | null>
  $provideImplementation(
    handle: number,
    uri: UriComponents,
    position: Position,
  ): Promise<Definition | DefinitionLink[] | null>
  $provideTypeDefinition(
    handle: number,
    uri: UriComponents,
    position: Position,
  ): Promise<Definition | DefinitionLink[] | null>
  $provideHover(handle: number, uri: UriComponents, position: Position): Promise<Hover | null>
  $provideCompletion(
    handle: number,
    uri: UriComponents,
    position: Position,
    context: ICompletionContext,
  ): Promise<CompletionItem[] | CompletionList | null>
  $resolveCompletionItem(handle: number, item: CompletionItem): Promise<CompletionItem>
  $provideSignatureHelp(
    handle: number,
    uri: UriComponents,
    position: Position,
    context: ISignatureHelpContext,
  ): Promise<SignatureHelp | null>
  $provideDocumentSymbols(
    handle: number,
    uri: UriComponents,
  ): Promise<DocumentSymbol[] | SymbolInformation[] | null>
  $provideRenameEdits(
    handle: number,
    uri: UriComponents,
    position: Position,
    newName: string,
  ): Promise<WorkspaceEdit | null>
  $provideWorkspaceSymbols(
    handle: number,
    query: string,
  ): Promise<WorkspaceSymbol[] | SymbolInformation[] | null>
  $provideFoldingRanges(handle: number, uri: UriComponents): Promise<FoldingRange[] | null>
  $provideDocumentLinks(handle: number, uri: UriComponents): Promise<DocumentLink[] | null>
  $resolveDocumentLink(handle: number, link: DocumentLink): Promise<DocumentLink | null>
  $provideDocumentHighlights(
    handle: number,
    uri: UriComponents,
    position: Position,
  ): Promise<DocumentHighlight[] | null>
  $provideSelectionRanges(
    handle: number,
    uri: UriComponents,
    positions: Position[],
  ): Promise<SelectionRange[] | null>
  $provideCodeActions(
    handle: number,
    uri: UriComponents,
    range: Range,
    context: ICodeActionContext,
  ): Promise<CodeAction[] | null>
}

/**
 * Renderer → exposed to the ext host: open/change/close of the renderer's text
 * models, mirrored into the host's TextDocument model so a plugin sees
 * `workspace.textDocuments` and the `onDidChangeTextDocument` family. Full text
 * each time (the framing carries no incremental edits).
 */
export interface IExtHostDocuments {
  $acceptDocumentOpen(
    uri: UriComponents,
    languageId: string,
    version: number,
    text: string,
  ): Promise<void>
  $acceptDocumentChange(uri: UriComponents, version: number, text: string): Promise<void>
  $acceptDocumentClose(uri: UriComponents): Promise<void>
}

/**
 * Ext host → exposed to the renderer: a plugin registers/unregisters language
 * providers (addressed by handle) and publishes diagnostics. The renderer builds
 * the matching Monaco provider shells and feeds diagnostics into the editor as
 * markers keyed by `owner` (the diagnostic collection name).
 */
export interface IMainThreadLanguages {
  $registerProvider(
    handle: number,
    type: LanguageProviderType,
    selector: DocumentSelector,
    metadata?: ILanguageProviderMetadata,
  ): Promise<void>
  $unregisterProvider(handle: number): Promise<void>
  $publishDiagnostics(
    owner: string,
    uri: UriComponents,
    diagnostics: readonly Diagnostic[],
  ): Promise<void>
  $clearDiagnostics(owner: string, uri?: UriComponents): Promise<void>
}

/** A single text edit applied by {@link IMainThreadEditor.$applyEdits}: replace
 *  `range` with `text` (insert when the range is empty, delete when text is ''). */
export interface ITextEditDto {
  readonly range: Range
  readonly text: string
}

/** A selection in the active editor. LSP-shaped (0-based); `anchor`/`active`
 *  preserve direction so the host can keep a reversed selection reversed. */
export interface ISelectionDto {
  readonly anchor: Position
  readonly active: Position
}

/** Where a decoration paints in the overview ruler. Mirrors Monaco's lane enum. */
export type OverviewRulerLaneDto = 1 | 2 | 4 | 7

/** Static look of a decoration type, allocated once via {@link IMainThreadEditor.$createDecorationType}.
 *  `gutterIconPath` is a data-URI (e.g. an inline SVG) painted in the glyph margin;
 *  the renderer turns these into a Monaco `IModelDecorationOptions`. */
export interface IDecorationRenderOptionsDto {
  readonly gutterIconPath?: string
  readonly isWholeLine?: boolean
  readonly backgroundColor?: string
  readonly borderColor?: string
  readonly borderWidth?: string
  readonly overviewRulerColor?: string
  readonly overviewRulerLane?: OverviewRulerLaneDto
}

/** A range a decoration type applies to (0-based, LSP-shaped). */
export interface IDecorationRangeDto {
  readonly range: Range
}

/** Snapshot of the active text editor returned by {@link IMainThreadEditor.$getActiveTextEditor}.
 *  Carries the live text so it stays consistent with `selections` — the debounced
 *  document mirror may lag the editor, so the host can't reuse its own model here. */
export interface IActiveTextEditorDto {
  readonly uri: UriComponents
  readonly languageId: string
  readonly version: number
  readonly text: string
  readonly selections: readonly ISelectionDto[]
}

/**
 * Ext host → exposed to the renderer: inspect and drive the active text editor.
 * Backs `window.activeTextEditor` and `TextEditor.edit()`. Coordinates are
 * LSP-shaped (0-based line/character) to match the document-sync convention;
 * the renderer converts to Monaco's 1-based positions internally.
 */
export interface IMainThreadEditor {
  /** Snapshot of the focused editor, or null when no text editor is active. */
  $getActiveTextEditor(): Promise<IActiveTextEditorDto | null>
  /**
   * Apply edits to the document at `uri` as one undo step. Edits are
   * non-overlapping; the renderer sorts and applies them bottom-up. Returns
   * false when the editor is gone or its version no longer matches.
   */
  $applyEdits(uri: UriComponents, version: number, edits: readonly ITextEditDto[]): Promise<boolean>
  /** Replace the selections of the editor at `uri` and reveal the primary one. */
  $setSelections(uri: UriComponents, selections: readonly ISelectionDto[]): Promise<void>
  /** Allocate a decoration type (look fixed up front), addressed later by `handle`. */
  $createDecorationType(handle: number, options: IDecorationRenderOptionsDto): Promise<void>
  /** Release a decoration type and remove every decoration it painted. */
  $disposeDecorationType(handle: number): Promise<void>
  /**
   * Replace the ranges decorated with `typeHandle` in the editor at `uri`. An
   * empty `ranges` clears that type. No-op when no editor is showing `uri`.
   */
  $setDecorations(
    uri: UriComponents,
    typeHandle: number,
    ranges: readonly IDecorationRangeDto[],
  ): Promise<void>
}

/**
 * Renderer → exposed to the ext host: active-editor changes, mirrored into the
 * host so a plugin sees `window.onDidChangeActiveTextEditor`. Carries the same
 * snapshot shape as {@link IMainThreadEditor.$getActiveTextEditor}; null when no
 * text editor is focused.
 */
export interface IExtHostEditor {
  $acceptActiveEditorChange(editor: IActiveTextEditorDto | null): Promise<void>
}

/** Storage scope mirroring the platform's `StorageScope`: 0 = global (all
 *  workspaces), 1 = workspace (the open folder). */
export type ExtHostStorageScope = 0 | 1

/**
 * Renderer → exposed to the ext host: persisted key/value storage backing a
 * plugin's `context.globalState` / `context.workspaceState`. The host keeps an
 * in-memory mirror (so the public `Memento.get` stays synchronous) and flushes
 * through here; values cross the wire as JSON strings. Keys are namespaced
 * per-extension by the renderer, so plugins can't read or clobber each other.
 */
export interface IMainThreadStorage {
  /** Read the whole state object for `extId` at `scope`, as a JSON string (or undefined). */
  $get(scope: ExtHostStorageScope, extId: string): Promise<string | undefined>
  /** Replace the whole state object for `extId` at `scope` with `valueJson`. */
  $set(scope: ExtHostStorageScope, extId: string, valueJson: string): Promise<void>
}

/** Webview capabilities crossing the wire. Mirrors the public `WebviewOptions`. */
export interface IWebviewOptionsDto {
  readonly enableScripts?: boolean
  /** Extra allow-listed resource roots (abs fs paths), beyond the extension dir. */
  readonly localResourceRoots?: readonly string[]
}

/**
 * Ext host → exposed to the renderer: custom-editor provider registration and
 * per-panel webview control. Providers are addressed by `providerHandle`
 * (allocated by the host at `registerCustomEditorProvider`); live panels by
 * `panelHandle` (allocated by the renderer when it opens a custom-editor tab and
 * asks the host to resolve it). `html`/`options` writes flow host → renderer here;
 * messages flow host → webview via `$postMessage`.
 */
export interface IMainThreadWebviews {
  /** Announce that a custom editor for `viewType` now has a live provider in the host. */
  $registerCustomEditorProvider(providerHandle: number, viewType: string): Promise<void>
  $unregisterCustomEditorProvider(providerHandle: number): Promise<void>
  /** Set the iframe capabilities + resource roots for a panel (before html). */
  $setWebviewOptions(panelHandle: number, options: IWebviewOptionsDto): Promise<void>
  /** Set (or replace) the panel's iframe HTML, re-rendering it. */
  $setWebviewHtml(panelHandle: number, html: string): Promise<void>
  /** Post a message to the scripts in the panel's webview. Resolves false if gone. */
  $postMessageToWebview(panelHandle: number, message: unknown): Promise<boolean>
}

/**
 * Renderer → exposed to the ext host: drives custom-editor resolution and relays
 * webview lifecycle/messages back to the host-side provider + panel handles.
 * When the user opens a matching file, the renderer creates the editor tab +
 * iframe, allocates a `panelHandle`, then calls `$resolveCustomEditor` so the
 * host runs the extension's `openCustomDocument` + `resolveCustomEditor`.
 */
export interface IExtHostWebviews {
  /**
   * Ask the host to resolve the custom editor for `viewType` against `uri` into
   * the panel `panelHandle` the renderer just created. The host opens the
   * document, then calls back through {@link IMainThreadWebviews} to fill it.
   */
  $resolveCustomEditor(
    providerHandle: number,
    panelHandle: number,
    viewType: string,
    uri: UriComponents,
  ): Promise<void>
  /** A message the webview scripts posted back, relayed to the panel's listener. */
  $onDidReceiveMessage(panelHandle: number, message: unknown): Promise<void>
  /** The editor tab hosting `panelHandle` was closed — dispose host-side state. */
  $disposeWebviewPanel(panelHandle: number): Promise<void>
}
