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
import type { CancellationToken } from '@universe-editor/platform'
import type { SerializedError } from '@universe-editor/platform'
import type { UriComponents } from '@universe-editor/platform'
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
  InlayHint,
  Location,
  Position,
  Range,
  SelectionRange,
  SemanticTokens,
  SignatureHelp,
  SymbolInformation,
  TextEdit,
  WorkspaceEdit,
  WorkspaceSymbol,
} from 'vscode-languageserver-types'
import type { IExtensionDescriptionDto } from '@universe-editor/extension-manifest'

export const ExtHostChannels = {
  /** Renderer → ext host: execute a contributed command. */
  extHostCommands: 'extHostCommands',
  /** Renderer → ext host: enumerate contributions, drive activation. */
  extHostExtensions: 'extHostExtensions',
  /** Ext host → renderer: an extension's `activate` threw — surface it to the user. */
  mainThreadExtensions: 'mainThreadExtensions',
  /** Ext host → renderer: register/unregister commands an extension created at runtime. */
  mainThreadCommands: 'mainThreadCommands',
  /** Ext host → renderer: `window.*` UI (messages, quick input, status bar). */
  mainThreadWindow: 'mainThreadWindow',
  /** Renderer → ext host: window-scoped callbacks (progress cancellation). */
  extHostWindow: 'extHostWindow',
  /** Ext host → renderer: the SCM model feeding the built-in source-control view. */
  mainThreadScm: 'mainThreadScm',
  /** Renderer → ext host: SCM view interactions (commit-box edits). */
  extHostScm: 'extHostScm',
  /** Ext host → renderer: gated filesystem access (path policy + IFileService). */
  mainThreadFs: 'mainThreadFs',
  /** Renderer → ext host: filesystem event batches feeding `workspace.createFileSystemWatcher`. */
  extHostFileEvents: 'extHostFileEvents',
  /** Ext host → renderer: declares/drops file-events interests ((base, pattern) pairs). */
  mainThreadFileEvents: 'mainThreadFileEvents',
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
  /** Ext host → renderer: timeline provider registrations + change events feeding the built-in timeline view. */
  mainThreadTimeline: 'mainThreadTimeline',
  /** Renderer → ext host: timeline page requests routed to a plugin's registered providers. */
  extHostTimeline: 'extHostTimeline',
  /** Ext host → renderer: tree-data provider registrations + invalidations feeding contributed views. */
  mainThreadTreeViews: 'mainThreadTreeViews',
  /** Renderer → ext host: tree children pulls + selection/expansion/visibility callbacks. */
  extHostTreeViews: 'extHostTreeViews',
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
  /**
   * Seed the initial Workspace Trust state before any activation. The renderer
   * calls this once, right after connecting, so `workspace.isTrusted` reads the
   * correct value inside extensions' `activate`.
   */
  $initializeWorkspaceTrust(trusted: boolean): Promise<void>
  /**
   * Seed the `env` namespace data before any activation. The renderer calls this
   * once, right after connecting (alongside `$initializeWorkspaceTrust`).
   */
  $initializeEnvironment(env: IExtHostEnvironmentDto): Promise<void>
  /**
   * Trust was granted for the current workspace (untrusted → trusted). Flips
   * `workspace.isTrusted` and fires `onDidGrantWorkspaceTrust`. A revoke is not
   * sent here — it restarts the whole host (activated extensions can't unload).
   */
  $onDidGrantWorkspaceTrust(): Promise<void>
  /**
   * Configuration values changed in the renderer; `changedKeys` carries every
   * effective key that changed (e.g. `git.autofetch`). The host fans this out as
   * `workspace.onDidChangeConfiguration`. Events fired while the host restarts
   * are lost — extensions re-read configuration after activation anyway.
   */
  $acceptConfigurationChanged(changedKeys: readonly string[]): Promise<void>
}

/**
 * Environment info the renderer pushes to the host once at connect, backing the
 * extension-facing `env` namespace. All values are plain strings (JSON-safe).
 */
export interface IExtHostEnvironmentDto {
  /** Product name (e.g. `Universe Editor`). */
  readonly appName: string
  /** Editor version. */
  readonly appVersion: string
  /** Unique per editor session; survives host restarts within the session. */
  readonly sessionId: string
  /** The OS-level deep-link scheme (e.g. `universe-editor`). */
  readonly uriScheme: string
  /** Display locale, e.g. `zh-CN`. */
  readonly language: string
  /** Random UUID generated once on the machine and persisted under userData. */
  readonly machineId: string
  /** Absolute path of the application install root. */
  readonly appRoot: string
}

/** An extension's `activate` threw. Reported host → renderer so the failure is
 *  visible (notification + a per-extension error badge) instead of silent. */
export interface IExtensionActivationErrorDto {
  /** The failing extension's id (e.g. `acme.widgets`). */
  readonly extensionId: string
  /** The extension's display name if known, for a human-readable message. */
  readonly displayName?: string
  /** The error's `message`. */
  readonly message: string
  /** The error's `stack` if any (shown in the detail view). */
  readonly stack?: string
}

/** An unhandled promise rejection in the extension host process. Reported
 *  host → renderer so a dev-mode notification and the E2E teardown gate can
 *  surface it instead of it staying a stderr-only log line. */
export interface IExtensionUnhandledRejectionDto {
  /** The rejection's `message` (or its string form for a non-Error reason). */
  readonly message: string
  /** The rejection's `stack` if any (shown in the detail view). */
  readonly stack?: string
}

/**
 * Ext host → exposed to the renderer: activation lifecycle the renderer surfaces
 * to the user. A failed `activate` is isolated (never tears down the host), but
 * the user still needs to know their extension has no functionality.
 */
export interface IMainThreadExtensions {
  /** An extension's `activate` threw. Provider → renderer push. */
  $onActivationError(error: IExtensionActivationErrorDto): void
  /** An unhandled promise rejection surfaced in the host. Provider → renderer push. */
  $onUnhandledRejection(report: IExtensionUnhandledRejectionDto): void
  /** A process-level unexpected error in the host (VSCode's MainThreadErrors). Provider → renderer push. */
  $onUnexpectedError(error: SerializedError): void
}

/**
 * Renderer → exposed to the ext host (renderer's ChannelServer). The host's
 * ChannelClient calls these when an extension registers/unregisters a command
 * at runtime (i.e. one not already known from its manifest).
 */
export interface IMainThreadCommands {
  $registerCommand(id: string): Promise<void>
  $unregisterCommand(id: string): Promise<void>
  /** Every command id the renderer's registry currently holds (built-in + contributed). */
  $getCommands(): Promise<string[]>
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
 * Options for a `window.withProgress` run, crossing the wire on
 * `mainThreadWindow`. `location` carries the public `ProgressLocation` value
 * (1 = SourceControl, 10 = Window, 15 = Notification).
 */
export interface IProgressOptionsDto {
  readonly location: number
  readonly title?: string
  readonly cancellable?: boolean
}

/** One progress step an extension task reports (message and/or percent delta). */
export interface IProgressStepDto {
  readonly message?: string
  readonly increment?: number
}

/** `window.showOpenDialog` options. `defaultUri` crosses as an fsPath string. */
export interface IOpenDialogOptionsDto {
  readonly defaultUri?: string
  readonly openLabel?: string
  readonly canSelectFiles?: boolean
  readonly canSelectFolders?: boolean
  readonly canSelectMany?: boolean
  readonly filters?: Record<string, readonly string[]>
  readonly title?: string
}

/** `window.showSaveDialog` options. `defaultUri` crosses as an fsPath string. */
export interface ISaveDialogOptionsDto {
  readonly defaultUri?: string
  readonly saveLabel?: string
  readonly filters?: Record<string, readonly string[]>
  readonly title?: string
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
  /** Read the OS clipboard's current text. */
  $clipboardReadText(): Promise<string>
  /** Write text onto the OS clipboard. */
  $clipboardWriteText(value: string): Promise<void>
  /**
   * Open a target through the workbench's opener service (external URLs go to
   * the OS browser; files open in an editor). Resolves to whether some opener
   * handled it. The target is a URI string (`Uri.toString()` or a raw URL/path).
   */
  $openExternal(target: string): Promise<boolean>
  /**
   * Mount the progress UI for `handle` (host-allocated). The indicator stays
   * up until `$endProgress`; steps arrive via `$reportProgress`. When the user
   * cancels a cancellable progress, the renderer pushes
   * `IExtHostWindow.$acceptProgressCanceled` back to the host.
   */
  $startProgress(handle: number, options: IProgressOptionsDto): Promise<void>
  $reportProgress(handle: number, value: IProgressStepDto): Promise<void>
  $endProgress(handle: number): Promise<void>
  /**
   * Workbench file picker; resolves to the picked fsPaths (several only when
   * `canSelectMany`), or undefined when cancelled. `filters` narrows the listed
   * files by extension.
   */
  $showOpenDialog(options: IOpenDialogOptionsDto): Promise<string[] | undefined>
  /** Save-location picker; resolves to the chosen fsPath, or undefined when cancelled. */
  $showSaveDialog(options: ISaveDialogOptionsDto): Promise<string | undefined>
}

/**
 * Window state the renderer pushes to the host. A plain boolean (JSON-safe);
 * the renderer seeds it once at connect and pushes again on every real change.
 */
export interface IExtHostWindowStateDto {
  readonly focused: boolean
}

/**
 * Ext host → exposed to the renderer (host's ChannelServer): window-scoped
 * callbacks the renderer pushes back for `window.*` operations — the
 * cancellation of a `withProgress` task's token and the window focus state.
 */
export interface IExtHostWindow {
  /** The user cancelled the progress UI for `handle`; the host cancels the task token. */
  $acceptProgressCanceled(handle: number): Promise<void>
  /**
   * The window focus state. The renderer seeds the initial value once at connect
   * (before any activation) and re-pushes on every real change; the host keeps a
   * local mirror so `window.state` reads synchronously and only fires
   * `onDidChangeWindowState` when the value actually changed.
   */
  $acceptWindowState(state: IExtHostWindowStateDto): Promise<void>
}

/** A filesystem entry's kind. Mirrors the subset of `IFileStat` extensions need. */
export type ExtHostFileType = 'file' | 'dir'

export interface IExtHostFileStatDto {
  readonly type: ExtHostFileType
  readonly size: number
  readonly mtime: number
}

/**
 * Wire form of the extension-api `RelativePattern`: `base` is the `file:` URI
 * the pattern is relative to, `pattern` a glob matched against base-relative
 * paths.
 */
export interface IRelativePatternDto {
  readonly base: UriComponents
  readonly pattern: string
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
  /** Both paths pass the same path policy as every other call. Without
   *  `overwrite`, an existing target rejects. */
  $rename(source: string, target: string, overwrite: boolean): Promise<void>
  $copy(source: string, target: string, overwrite: boolean): Promise<void>
  /**
   * Enumerate workspace files matching the `include` glob (VSCode glob
   * semantics over workspace-relative paths) and return their fsPaths. A
   * `RelativePattern` include roots the enumeration at `base` (must resolve
   * inside the workspace) and matches `pattern` against base-relative paths.
   * `exclude`: null → the renderer's configured search excludes
   * (files.exclude ∪ search.exclude); an empty array → no excludes at all; a
   * `RelativePattern` entry excludes matches under its own base only.
   * `maxResults`: null → unbounded (still internally capped at enumeration).
   * The trailing token rides the channel's cancel path: cancelling it kills
   * the underlying enumeration instead of merely discarding a late result.
   */
  $findFiles(
    include: string | IRelativePatternDto,
    exclude: readonly (string | IRelativePatternDto)[] | null,
    maxResults: number | null,
    token?: CancellationToken,
  ): Promise<string[]>
}

/** One filesystem event batch entry, renderer → ext host, for
 *  `workspace.createFileSystemWatcher`. `uri` is a `file:` UriComponents. */
export interface IFileChangeEventDto {
  readonly type: 'created' | 'changed' | 'deleted'
  readonly uri: UriComponents
}

/**
 * Renderer → exposed to the ext host: filesystem event batches pushed only
 * while the host declared interest via {@link IMainThreadFileEvents}. Events
 * cover the recursive workspace watch (plus any out-of-workspace paths the
 * workbench watches); the renderer pre-filters by the declared interest
 * patterns, and the host re-checks against each watcher's glob.
 */
export interface IExtHostFileEvents {
  $acceptFileEvents(events: readonly IFileChangeEventDto[]): Promise<void>
}

/**
 * One declared file-events interest, ext host → renderer. `base` is the
 * watcher's anchor folder (`file:` UriComponents): a `RelativePattern` base,
 * or the literal root of an absolute glob; undefined means a workspace-relative
 * glob covered by the recursive workspace watch. `pattern` is the glob the
 * watcher matches against paths relative to that anchor — the renderer
 * pre-filters event batches with it (`compileGlobMatcher`) so events no live
 * watcher could match never cross the wire; the host still re-checks every
 * delivered event itself.
 */
export interface IFileWatcherInterestDto {
  readonly base: UriComponents | undefined
  readonly pattern: string
}

/**
 * Ext host → exposed to the renderer: the host declares interest in filesystem
 * events for its live extension-created FileSystemWatchers. Interests are
 * keyed by `(base, pattern)`: the host reference-counts identical interests
 * and only the 0↔n transitions cross the wire, so N watchers with the same
 * glob cost one pair of calls — and a host with no watchers costs zero RPC
 * traffic.
 *
 * A base outside the workspace makes the renderer arm an out-of-workspace
 * watch for that folder (reference-counted across watchers sharing it) so its
 * events reach the host; a base inside the workspace needs no extra watch. A
 * pattern anchoring exactly one file (a slash-containing literal) watches just
 * that file instead of the whole tree.
 */
export interface IMainThreadFileEvents {
  $subscribeFileEvents(interest: IFileWatcherInterestDto): Promise<void>
  $unsubscribeFileEvents(interest: IFileWatcherInterestDto): Promise<void>
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
  | 'documentFormatting'
  | 'documentSemanticTokens'
  | 'documentRangeSemanticTokens'
  | 'codeLens'
  | 'documentRangeFormatting'
  | 'onTypeFormatting'
  | 'inlayHints'

/** Language ids a provider applies to. Empty for workspace-wide providers. */
export type DocumentSelector = readonly string[]

/**
 * Lifecycle state of a language server, reported by a plugin so the renderer can
 * tell the user it is coming up. `starting` covers spawn + handshake (during
 * which language requests block); `ready` once usable; `error` on start failure.
 */
export type LanguageServerStatus = 'starting' | 'ready' | 'error'

/** Extra registration data Monaco needs up front (trigger characters, legends). */
export interface ILanguageProviderMetadata {
  readonly triggerCharacters?: readonly string[]
  readonly signatureHelpTriggerCharacters?: readonly string[]
  readonly signatureHelpRetriggerCharacters?: readonly string[]
  /** Semantic-tokens legend (token type / modifier names, index = wire value).
   *  Monaco's `getLegend()` must return it synchronously, so it rides along at
   *  registration time rather than being fetched per request. */
  readonly semanticTokensLegend?: ISemanticTokensLegend
  /** On-type formatting trigger characters (first + more). Monaco exposes them
   *  synchronously as `autoFormatTriggerCharacters`, so they cross at registration. */
  readonly onTypeFormattingTriggerCharacters?: readonly string[]
  /** Inlay hints: the provider implements `resolveInlayHint`, so the renderer
   *  shells out lazy label/tooltip resolution instead of dropping `data`. */
  readonly inlayHintsResolve?: boolean
}

/** Names for the numeric token-type / modifier indices in `SemanticTokens.data`. */
export interface ISemanticTokensLegend {
  readonly tokenTypes: readonly string[]
  readonly tokenModifiers: readonly string[]
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

/** Formatting options Monaco passes to a document-formatting provider. Mirrors
 *  LSP `FormattingOptions` (the two fields every formatter gets). */
export interface IFormattingOptionsDto {
  readonly tabSize: number
  readonly insertSpaces: boolean
}

/**
 * Inlay hint crossing the wire. The LSP `data` field never crosses: it is opaque
 * resolve payload (and may not be JSON-serializable), so the host keeps the
 * original hint objects and tags each DTO with its cache coordinates
 * (`resolveCacheId` + `resolveIndex`) when the provider supports lazy resolve.
 * `$resolveInlayHint` round-trips those coordinates back.
 */
export type IInlayHintDto = Omit<InlayHint, 'data'> & {
  readonly resolveCacheId?: number
  readonly resolveIndex?: number
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
  /**
   * Cancel the in-flight workspace-symbol query for `handle` (latest-wins per
   * handle: a new `$provideWorkspaceSymbols` already cancels the previous one;
   * this covers picker-hide / keystroke-cancellation with no follow-up query).
   * Fire-and-forget — the pending request resolves with whatever the provider
   * returns for a cancelled token.
   */
  $cancelWorkspaceSymbols(handle: number): void
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
  $provideDocumentFormattingEdits(
    handle: number,
    uri: UriComponents,
    options: IFormattingOptionsDto,
  ): Promise<TextEdit[] | null>
  $provideDocumentRangeFormattingEdits(
    handle: number,
    uri: UriComponents,
    range: Range,
    options: IFormattingOptionsDto,
  ): Promise<TextEdit[] | null>
  $provideOnTypeFormattingEdits(
    handle: number,
    uri: UriComponents,
    position: Position,
    ch: string,
    options: IFormattingOptionsDto,
  ): Promise<TextEdit[] | null>
  /**
   * Inlay hints for `range`. When the provider implements `resolveInlayHint`,
   * the host caches the returned hints (per handle, latest provide wins) and
   * tags each DTO with its cache coordinates; `$resolveInlayHint` round-trips
   * them to resolve label/tooltip lazily.
   */
  $provideInlayHints(
    handle: number,
    uri: UriComponents,
    range: Range,
  ): Promise<IInlayHintDto[] | null>
  /**
   * Resolve the hint at (`cacheId`, `index`) in the host-side cache of `handle`.
   * Returns the resolved hint (still without `data`), or null when the cache
   * entry is gone (a newer provide superseded it) — the renderer then keeps the
   * hint as provided.
   */
  $resolveInlayHint(handle: number, cacheId: number, index: number): Promise<IInlayHintDto | null>
  $provideDocumentSemanticTokens(handle: number, uri: UriComponents): Promise<SemanticTokens | null>
  $provideDocumentRangeSemanticTokens(
    handle: number,
    uri: UriComponents,
    range: Range,
  ): Promise<SemanticTokens | null>
  $provideCodeLenses(handle: number, uri: UriComponents): Promise<CodeLens[] | null>
  $resolveCodeLens(handle: number, lens: CodeLens): Promise<CodeLens | null>
  /**
   * Renderer → host push (fire-and-forget): the set of resources whose
   * diagnostics changed (any owner — extension collections and built-in language
   * services alike), backing `languages.onDidChangeDiagnostics`. Batched and
   * debounced by the renderer; only pushed while the host declared interest via
   * `IMainThreadLanguages.$subscribeDiagnostics`.
   */
  $acceptDiagnosticsChange(uris: readonly UriComponents[]): Promise<void>
}

/**
 * One incremental document edit, LSP-shaped (0-based `range` against the state
 * after the previous change in the same batch was applied). A change without a
 * `range` replaces the whole document — used for model flushes (file reload,
 * programmatic setValue) where no delta exists.
 */
export interface TextDocumentContentChangeDto {
  readonly range?: Range
  readonly text: string
}

/**
 * Renderer → exposed to the ext host: open/change/close of the renderer's text
 * models, mirrored into the host's TextDocument model so a plugin sees
 * `workspace.textDocuments` and the `onDidChangeTextDocument` family. Open
 * carries the full text once; changes are incremental deltas (VSCode parity —
 * a multi-MB document must never re-cross the wire per keystroke).
 */
export interface IExtHostDocuments {
  $acceptDocumentOpen(
    uri: UriComponents,
    languageId: string,
    version: number,
    text: string,
  ): Promise<void>
  $acceptDocumentChange(
    uri: UriComponents,
    version: number,
    changes: readonly TextDocumentContentChangeDto[],
  ): Promise<void>
  $acceptDocumentClose(uri: UriComponents): Promise<void>
  /**
   * Renderer → host, WAITING round trip (unlike the fire-and-forget `$accept*`
   * above): the renderer is about to save `uri` and asks the host to run every
   * `onWillSaveTextDocument` listener, collecting the text edits they contribute
   * (e.g. ESLint fix-all-on-save). The host bounds each listener with a timeout
   * and returns the merged edits; the renderer applies them to the model before
   * writing to disk. `reason` mirrors LSP `TextDocumentSaveReason`
   * (1 = manual, 2 = after delay, 3 = focus out).
   */
  $provideWillSaveEdits(uri: UriComponents, reason: WillSaveReason): Promise<TextEdit[]>
  /**
   * Renderer → host push (fire-and-forget): the document at `uri` was written
   * to disk. The renderer flushes its debounced mirror changes first, so the
   * host's mirrored document already holds the saved text when this arrives.
   * Backs `workspace.onDidSaveTextDocument`.
   */
  $acceptDocumentSave(uri: UriComponents): Promise<void>
}

/** Why a save is happening. Mirrors LSP `TextDocumentSaveReason`. */
export type WillSaveReason = 1 | 2 | 3

/**
 * Wire form of a language configuration handed to
 * {@link IMainThreadLanguages.$setLanguageConfiguration}. Mirrors the extension
 * API's `LanguageConfiguration` with `wordPattern` flattened to its source string
 * (a RegExp cannot cross the structured-clone wire).
 */
export interface ILanguageConfigurationDto {
  readonly comments?: { readonly lineComment?: string; readonly blockComment?: [string, string] }
  readonly brackets?: readonly [string, string][]
  readonly autoClosingPairs?: readonly {
    readonly open: string
    readonly close: string
    readonly notIn?: readonly string[]
  }[]
  readonly surroundingPairs?: readonly { readonly open: string; readonly close: string }[]
  readonly wordPattern?: string
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
  /**
   * Every diagnostic the workbench currently shows (all marker owners — every
   * extension's collections plus the built-in language services), backing
   * `languages.getDiagnostics`. With `uri`, only that resource's diagnostics
   * are returned; without it, one entry per resource that has any. Diagnostics
   * are LSP-shaped, the same shape `$publishDiagnostics` accepts.
   */
  $getDiagnostics(uri?: UriComponents): Promise<Array<[UriComponents, Diagnostic[]]>>
  /**
   * Interest declaration for `IExtHostLanguages.$acceptDiagnosticsChange`,
   * reference-counted like the file-events pair: the renderer only pushes
   * marker-change notifications while at least one host-side
   * `onDidChangeDiagnostics` listener is alive.
   */
  $subscribeDiagnostics(): Promise<void>
  $unsubscribeDiagnostics(): Promise<void>
  /**
   * A CodeLens provider's lenses changed (its `onDidChangeCodeLenses` fired):
   * tell the renderer to re-request lenses for that provider. Provider → renderer
   * push, the same direction as `$publishDiagnostics` (CodeLens is the only
   * `provide*` feature with a server-driven refresh signal).
   */
  $emitCodeLensDidChange(handle: number): void
  /**
   * An inlay-hints provider's hints changed (its `onDidChangeInlayHints` fired):
   * tell the renderer to re-request hints for that provider. Same push direction
   * and per-handle emitter wiring as `$emitCodeLensDidChange`.
   */
  $emitInlayHintsDidChange(handle: number): void
  /**
   * A document-semantic-tokens provider's tokens changed (its
   * `onDidChangeSemanticTokens` fired): tell the renderer to re-request tokens
   * for that provider. Same push direction and per-handle emitter wiring as
   * `$emitCodeLensDidChange`.
   */
  $emitSemanticTokensDidChange(handle: number): void
  /** Every language id the editor currently knows (Monaco's language registry). */
  $getLanguages(): Promise<string[]>
  /**
   * A plugin reported its language server's lifecycle state (starting/ready/error),
   * keyed by `id` (e.g. `'typescript'`). Provider → renderer push; the renderer
   * surfaces it (status-bar spinner) and lets navigation commands await readiness
   * instead of blocking silently. Not tied to a provider handle — the server's
   * state spans all its providers.
   */
  $setLanguageServerStatus(id: string, status: LanguageServerStatus): void
  /**
   * Switch an already-mirrored document's language id. The renderer calls
   * `setModelLanguage`, which drives the document-sync pipeline to re-push the
   * document as close(old) + open(new). Rejects when no live model matches `uri`.
   */
  $setTextDocumentLanguage(uri: UriComponents, languageId: string): Promise<void>
  /**
   * Apply a language configuration (comments/brackets/wordPattern/…) addressed by
   * a host-allocated `handle`; the handle is the unit of revocation via
   * `$unregisterLanguageConfiguration` (Monaco's own registration disposable is
   * tracked by handle renderer-side).
   */
  $setLanguageConfiguration(
    handle: number,
    languageId: string,
    configuration: ILanguageConfigurationDto,
  ): Promise<void>
  /** Revoke a language configuration previously registered under `handle`. */
  $unregisterLanguageConfiguration(handle: number): Promise<void>
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

/**
 * A color on the decoration wire: either a literal CSS color string, or a
 * `ThemeColor` reference serialized to `{ id }` (resolved by the renderer against
 * the color registry / current theme).
 */
export type ThemeColorDto = string | { readonly id: string }

/** Static look of a decoration type, allocated once via {@link IMainThreadEditor.$createDecorationType}.
 *  `gutterIconPath` is a data-URI (e.g. an inline SVG) painted in the glyph margin;
 *  the renderer turns these into a Monaco `IModelDecorationOptions`. */
export interface IDecorationRenderOptionsDto {
  readonly gutterIconPath?: string
  readonly isWholeLine?: boolean
  readonly backgroundColor?: ThemeColorDto
  readonly borderColor?: ThemeColorDto
  readonly borderWidth?: string
  readonly overviewRulerColor?: ThemeColorDto
  readonly overviewRulerLane?: OverviewRulerLaneDto
}

/** A range a decoration type applies to (0-based, LSP-shaped). */
export interface IDecorationRangeDto {
  readonly range: Range
}

/** Snapshot of the active text editor returned by {@link IMainThreadEditor.$getActiveTextEditor}.
 *  Deliberately carries NO document text (VSCode parity): the host resolves the
 *  document from its ExtHostDocuments mirror by `uri` — re-shipping a multi-MB
 *  buffer on every tab switch would stall the renderer main thread. */
export interface IActiveTextEditorDto {
  readonly uri: UriComponents
  readonly languageId: string
  readonly version: number
  readonly selections: readonly ISelectionDto[]
}

/** Options for {@link IMainThreadEditor.$showTextDocument}; mirrors the public
 *  `TextDocumentShowOptions`. `selection` is LSP-shaped (0-based). */
export interface ITextDocumentShowOptionsDto {
  readonly preserveFocus?: boolean
  readonly preview?: boolean
  readonly selection?: Range
}

/**
 * Ext host → exposed to the renderer: inspect and drive the active text editor.
 * Backs `window.activeTextEditor` and `TextEditor.edit()`. Coordinates are
 * LSP-shaped (0-based line/character) to match the document-sync convention;
 * the renderer converts to Monaco's 1-based positions internally.
 */
/** Options for {@link IMainThreadEditor.$openUntitledDocument}; mirrors the
 *  public `openTextDocument(options)` overload. */
export interface IOpenUntitledDocumentOptions {
  readonly language?: string
  readonly content?: string
}

export interface IMainThreadEditor {
  /** Snapshot of the focused editor, or null when no text editor is active. */
  $getActiveTextEditor(): Promise<IActiveTextEditorDto | null>
  /**
   * Ensure the document at `uri` enters the renderer→host document mirror (its
   * `$acceptDocumentOpen` follows asynchronously, once language activation has
   * run). A document already mirrored (open in an editor) is reused as-is;
   * otherwise the file is read from disk into a model that joins the same sync
   * pipeline. A `untitled:` URI creates a backing model without touching disk
   * (its path seeds the later Save-As dialog). Rejects when the file can't be
   * read or the scheme isn't `file`/`untitled`.
   */
  $openTextDocument(uri: UriComponents): Promise<void>
  /**
   * Create an untitled (never-on-disk) text document in the mirror and resolve
   * its URI. No editor tab is opened — showing it is `showTextDocument`'s job.
   * Closing an untitled model disposes the buffer outright, so a dropped
   * document leaves the mirror immediately (an empty file document lingers
   * until the window closes).
   */
  $openUntitledDocument(options: IOpenUntitledDocumentOptions): Promise<UriComponents>
  /**
   * Open the document at `uri` in a text editor and resolve its snapshot (same
   * shape as `$getActiveTextEditor`; null when the editor never mounted).
   * `selection` is revealed; `preview` opens into the group's unpinned preview
   * slot; `preserveFocus` shows the editor without moving keyboard focus.
   * Supports `file:` and `untitled:` URIs.
   */
  $showTextDocument(
    uri: UriComponents,
    options: ITextDocumentShowOptionsDto,
  ): Promise<IActiveTextEditorDto | null>
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
  /**
   * Apply an LSP-shaped WorkspaceEdit across files (live models get undoable
   * model edits; unopened files are read/patched/written on disk). File
   * operations (`documentChanges` create/rename/delete entries) run through the
   * file service in array order. Resolves false when any entry fails; entries
   * already applied are not rolled back.
   */
  $applyWorkspaceEdit(edit: WorkspaceEdit): Promise<boolean>
}

/**
 * Renderer → exposed to the ext host: active-editor changes, mirrored into the
 * host so a plugin sees `window.onDidChangeActiveTextEditor`. Carries the same
 * snapshot shape as {@link IMainThreadEditor.$getActiveTextEditor}; null when no
 * text editor is focused.
 */
export interface IExtHostEditor {
  $acceptActiveEditorChange(editor: IActiveTextEditorDto | null): Promise<void>
  /**
   * The visible text editors — one per editor group (the group's active editor,
   * provided it is a text editor; custom editors never appear). Pushed as a whole
   * set, coalesced by the renderer so a layout burst arrives as a single update;
   * the latest push replaces the previous set wholesale. Backs
   * `window.visibleTextEditors` / `onDidChangeVisibleTextEditors`.
   */
  $acceptVisibleEditorsChange(editors: readonly IActiveTextEditorDto[]): Promise<void>
  /**
   * Selection changes in the ACTIVE text editor, debounced (~30ms trailing) by
   * the renderer so a typing burst arrives as a single event carrying the latest
   * selections. `kind` mirrors the public `TextEditorSelectionChangeKind`
   * (1 = keyboard, 2 = mouse, 3 = command); undefined when the change was
   * programmatic (e.g. the host's own `$setSelections`).
   */
  $acceptSelectionChange(
    uri: UriComponents,
    selections: readonly ISelectionDto[],
    kind: number | undefined,
  ): Promise<void>
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

/** `showOptions` of `window.createWebviewPanel`, crossing the wire. */
export interface IWebviewPanelShowOptionsDto {
  /** Open the tab without moving focus to it. */
  readonly preserveFocus?: boolean
}

/**
 * Two versions of a resource to compare, crossing the wire when the workbench
 * opens a custom editor as a diff (`_workbench.openWebviewDiff`). Content bytes
 * are base64-encoded so the payload stays JSON-safe across ProxyChannel. Mirrors
 * the public `WebviewDiffContext` (bytes decoded back to `Uint8Array` host-side).
 */
export interface IWebviewDiffContextDto {
  readonly leftUri: UriComponents
  readonly rightUri: UriComponents
  /** Base64-encoded bytes of the left-hand (baseline) side. */
  readonly leftBase64: string
  /** Base64-encoded bytes of the right-hand (modified) side. */
  readonly rightBase64: string
  readonly title: string
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
  /**
   * Create an extension-owned webview panel (`window.createWebviewPanel`) and
   * open its editor tab. `panelHandle` is allocated HOST-side and is negative,
   * disjoint from the renderer-allocated custom-editor handles. `options` rides
   * along so no separate `$setWebviewOptions` races the create.
   */
  $createWebviewPanel(
    panelHandle: number,
    viewType: string,
    title: string,
    options: IWebviewOptionsDto,
    showOptions?: IWebviewPanelShowOptionsDto,
  ): Promise<void>
  /** Close the tab of an extension-owned panel (`WebviewPanel.dispose()`). */
  $disposeWebviewPanel(panelHandle: number): Promise<void>
  /** Bring the extension-owned panel's tab to the front. */
  $revealWebviewPanel(panelHandle: number, preserveFocus?: boolean): Promise<void>
  /** Retitle an extension-owned panel's tab (`WebviewPanel.title = …`). */
  $setWebviewTitle(panelHandle: number, title: string): Promise<void>
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
    diff?: IWebviewDiffContextDto,
  ): Promise<void>
  /** A message the webview scripts posted back, relayed to the panel's listener. */
  $onDidReceiveMessage(panelHandle: number, message: unknown): Promise<void>
  /** The editor tab hosting `panelHandle` was closed — dispose host-side state. */
  $disposeWebviewPanel(panelHandle: number): Promise<void>
  /**
   * The user closed an extension-owned panel's tab — the host fires
   * `onDidDispose` and drops the panel (WITHOUT calling `$disposeWebviewPanel`
   * back, which would be a redundant round-trip).
   */
  $acceptPanelDisposed(panelHandle: number): Promise<void>
  /**
   * An extension-owned panel's tab mounted/unmounted (or its group
   * activated/deactivated) — drives the host-side `active`/`visible` getters
   * and `onDidChangeViewState`. Unmount only means hidden: the panel itself
   * stays alive until disposed.
   */
  $acceptPanelViewState(panelHandle: number, active: boolean, visible: boolean): Promise<void>
}
