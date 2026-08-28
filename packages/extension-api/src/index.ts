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
import type { TimelineProvider } from './timeline.js'
import type { TreeDataProvider, TreeView, TreeViewOptions } from './treeView.js'
import type {
  CustomEditorOptions,
  CustomReadonlyEditorProvider,
  WebviewOptions,
  WebviewPanel,
} from './webview.js'
import type { CancellationToken, Disposable, Event } from './util.js'
import { Uri, type UriComponents } from './uri.js'
import { asRelativePathImpl, workspaceFolderName } from './workspacePaths.js'
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
  SemanticTokensLegend,
  SignatureHelp,
  SymbolInformation,
  TextEdit,
  WorkspaceEdit,
  WorkspaceSymbol,
} from 'vscode-languageserver-types'

export * from './scm.js'
export * from './timeline.js'
export * from './treeView.js'
export * from './webview.js'

/** Re-exported LSP types that appear in language-provider signatures, so plugin
 *  authors get a self-contained API surface (the Universe equivalent of `vscode.d.ts`). */
export type {
  CompletionItem,
  CompletionList,
  CodeAction,
  CodeLens,
  CreateFile,
  CreateFileOptions,
  Definition,
  DefinitionLink,
  DeleteFile,
  DeleteFileOptions,
  Diagnostic,
  DocumentHighlight,
  DocumentLink,
  DocumentSymbol,
  FoldingRange,
  Hover,
  InlayHint,
  InlayHintLabelPart,
  Location,
  LocationLink,
  MarkupContent,
  Position,
  Range,
  RenameFile,
  RenameFileOptions,
  SelectionRange,
  SemanticTokens,
  SemanticTokensLegend,
  SignatureHelp,
  SymbolInformation,
  TextDocumentEdit,
  TextEdit,
  WorkspaceEdit,
  WorkspaceSymbol,
} from 'vscode-languageserver-types'

/** `FoldingRangeKind` is a value (its `Comment`/`Imports`/`Region` constants),
 *  so it re-exports separately from the type-only block above. */
export { FoldingRangeKind } from 'vscode-languageserver-types'

/** `InlayHintKind` is a value (its `Type`/`Parameter` constants), so it
 *  re-exports separately from the type-only block above. */
export { InlayHintKind } from 'vscode-languageserver-types'

/** The editor (engine) version this SDK build targets — a bundle-time constant,
 *  like the `@types/vscode` version, NOT the live host version (use
 *  `env.appVersion` for that). Tracks the editor app version 1:1 (single
 *  version space); the host checks `engines.universe` against its own runtime
 *  version. Bumping is governed by COMPATIBILITY.md — keep in sync with
 *  package.json (release.mjs syncs both; publish preflight enforces it). */
export const version = '0.13.5'

export { CancellationTokenSource, Disposable, EventEmitter } from './util.js'
export type { CancellationToken, Event } from './util.js'
export { Uri } from './uri.js'
export type { UriComponents } from './uri.js'
export { RelativePattern } from './relativePattern.js'
export type { GlobPattern, RelativePatternBase } from './relativePattern.js'
import type { GlobPattern } from './relativePattern.js'

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
  /**
   * List the ids of every registered command. With `filterInternal`, internal
   * (underscore-prefixed, e.g. `_workbench.*`) commands are excluded.
   */
  getCommands(filterInternal?: boolean): Promise<string[]>
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

/** Where a progress indicator shows while a `window.withProgress` task runs. */
export enum ProgressLocation {
  /** Along the Source Control view. Currently rendered as {@link Window}. */
  SourceControl = 1,
  /** Quiet spinner in the window's status bar. */
  Window = 10,
  /** Notification entry with an optional cancel button and percent bar. */
  Notification = 15,
}

export interface ProgressOptions {
  readonly location: ProgressLocation
  readonly title?: string
  /** When true, the UI offers a cancel control that flips the task's token. */
  readonly cancellable?: boolean
}

/** Reports progress for a running task; each `report` updates the indicator. */
export interface Progress<T> {
  report(value: T): void
}

/** Options for {@link WindowApi.showOpenDialog}. */
export interface OpenDialogOptions {
  /** Where the dialog starts browsing. */
  defaultUri?: Uri
  /** Confirm button label (e.g. "Open"). */
  openLabel?: string
  canSelectFiles?: boolean
  canSelectFolders?: boolean
  /** When true, the user may pick several entries; the result holds them all. */
  canSelectMany?: boolean
  /**
   * File-type filters shown in the dialog (`{ 'Images': ['png', 'jpg'] }`).
   * Entries whose extension matches none of the groups are hidden; a group
   * containing `*` matches everything.
   */
  filters?: Record<string, string[]>
  readonly title?: string
}

/** Options for {@link WindowApi.showSaveDialog}. */
export interface SaveDialogOptions {
  /** Default save location (including the file name). */
  defaultUri?: Uri
  /** Confirm button label (e.g. "Save"). */
  saveLabel?: string
  /** Accepted for compatibility; the current dialog does not filter. */
  filters?: Record<string, string[]>
  readonly title?: string
}

/** A channel in the Output panel that an extension can write to. */
export interface OutputChannel extends Disposable {
  readonly name: string
  append(text: string): void
  appendLine(text: string): void
  clear(): void
  show(): void
}

/** Snapshot of the editor window's focus state. */
export interface WindowState {
  /** Whether the editor window currently has focus. False when the window is
   *  minimized or another application is active. */
  readonly focused: boolean
}

/** The `window` namespace: UI surfaced through the host's renderer. */
export interface WindowApi {
  /**
   * Current window focus state, read synchronously. Seeded by the renderer
   * before any extension activates, so it is correct inside `activate()`.
   */
  readonly state: WindowState
  /**
   * Fires when the window focus state changes (gained/lost focus, minimized,
   * hidden). Only fires on a real change — the same value never fires twice.
   */
  readonly onDidChangeWindowState: Event<WindowState>
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
  /**
   * Show a transient status-bar message (left side, low priority). The returned
   * Disposable removes it early; disposing is idempotent. Each call is
   * independent — a later message does not replace an earlier one (they may
   * coexist; this is not VSCode's message stack).
   */
  setStatusBarMessage(text: string): Disposable
  /** Variant that auto-hides after `hideAfterTimeout` milliseconds. */
  setStatusBarMessage(text: string, hideAfterTimeout: number): Disposable
  /** Variant that auto-hides when `hideWhenDone` settles. */
  setStatusBarMessage(text: string, hideWhenDone: Promise<unknown>): Disposable
  /**
   * Run `task` with a progress indicator at `options.location`. The task
   * receives a reporter (`{ message?, increment? }` steps; increments
   * accumulate toward 100 percent) and a token that flips when the user cancels
   * a `cancellable` progress. Resolves with the task's result; the indicator is
   * always torn down when the task settles.
   */
  withProgress<R>(
    options: ProgressOptions,
    task: (
      progress: Progress<{ message?: string; increment?: number }>,
      token: CancellationToken,
    ) => Promise<R>,
  ): Promise<R>
  /**
   * Show the workbench file-open dialog. Resolves to the picked file URIs, or
   * undefined when the user cancels.
   */
  showOpenDialog(options?: OpenDialogOptions): Promise<Uri[] | undefined>
  /**
   * Show the workbench save dialog. Resolves to the chosen target file URI, or
   * undefined when the user cancels.
   */
  showSaveDialog(options?: SaveDialogOptions): Promise<Uri | undefined>
  /** The focused text editor, or undefined when no editor has focus. A snapshot —
   *  re-fetch after an external change rather than holding the handle long-term.
   *  Never hangs: when the focused document's mirror has not landed yet (notably
   *  when called inside `activate()` — the first document push waits for
   *  activation to return, so waiting here would deadlock), it resolves
   *  undefined instead of waiting; listen to
   *  {@link WindowApi.onDidChangeActiveTextEditor} or
   *  {@link WorkspaceApi.onDidOpenTextDocument} and re-fetch. */
  getActiveTextEditor(): Promise<TextEditor | undefined>
  /** Fires when the focused text editor changes; argument is undefined when focus
   *  leaves all text editors. The editor is a fresh snapshot, as from
   *  {@link WindowApi.getActiveTextEditor}. */
  readonly onDidChangeActiveTextEditor: Event<TextEditor | undefined>
  /** The currently visible text editors — one per editor group (its active
   *  editor), so a split view yields one entry per side. Custom editors never
   *  appear. Each entry is a snapshot (same semantics as
   *  {@link WindowApi.getActiveTextEditor}): read fresh after
   *  {@link WindowApi.onDidChangeVisibleTextEditors} rather than holding handles
   *  long-term. A freshly opened cold document (first touch activating its
   *  language) enters the set a moment later than the tab itself: until its
   *  mirror lands, the getter and the event carry only the already-mirrored
   *  members and converge on {@link WindowApi.onDidChangeVisibleTextEditors}. */
  readonly visibleTextEditors: readonly TextEditor[]
  /** Fires when the set of visible text editors changes (tab switched, group
   *  opened/closed). Content or selection edits inside an already-visible editor
   *  do not fire this event. The array carries fresh snapshots. A cold document
   *  whose mirror has not yet landed is held back for a short grace so the set
   *  normally arrives complete; a mirror stuck beyond that reports the known
   *  subset first and a follow-up event once the document merges in. */
  readonly onDidChangeVisibleTextEditors: Event<readonly TextEditor[]>
  /**
   * Open the document at `target` in a text editor and resolve its snapshot.
   * A `Uri`/string target is loaded like {@link WorkspaceApi.openTextDocument}
   * first, so the returned editor's document is the live mirrored one.
   */
  showTextDocument(
    target: TextDocument | Uri | string,
    options?: TextDocumentShowOptions,
  ): Promise<TextEditor>
  /**
   * Fires when the selection in the active text editor changes (debounced: a
   * typing burst delivers the latest selection once). Changes in background
   * editors do not fire this event.
   */
  readonly onDidChangeTextEditorSelection: Event<TextEditorSelectionChangeEvent>
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
  /**
   * Create an extension-owned webview panel (the workbench mirrors it as an
   * editor tab). Unlike a custom editor, the extension drives the lifecycle:
   * fill `panel.webview.html`, `reveal()` to re-activate, `dispose()` to close.
   * Differences from VSCode: there is no `ViewColumn` argument (the tab opens in
   * the active group); `retainContextWhenHidden` is not supported (the iframe is
   * not rebuilt on reveal — the panel's html/options persist); and there is no
   * `WebviewPanelSerializer`, so a panel is not restored after a window reload
   * (recreate it on next activation).
   */
  createWebviewPanel(
    viewType: string,
    title: string,
    showOptions?: { preserveFocus?: boolean },
    options?: WebviewOptions,
  ): WebviewPanel
  /**
   * Register a data provider for a view declared via `contributes.views`
   * (`viewId` is the manifest view id). The workbench pulls children lazily and
   * re-pulls the whole view when the provider fires `onDidChangeTreeData`.
   */
  registerTreeDataProvider<T>(viewId: string, provider: TreeDataProvider<T>): Disposable
  /**
   * Same registration as {@link WindowApi.registerTreeDataProvider}, plus a
   * {@link TreeView} handle mirroring the view's visibility / selection /
   * expansion back to the extension. Differences from VSCode: no `reveal`, no
   * `title`/`description`/`message`, no badges, no drag & drop.
   */
  createTreeView<T>(viewId: string, options: TreeViewOptions<T>): TreeView<T>
}

/** A text document open in the editor. URIs/positions are LSP-shaped. */
export interface TextDocument {
  readonly uri: UriComponents
  readonly languageId: string
  /** Monotonic version, bumped on every edit. */
  readonly version: number
  /** True when the document has no file identity yet (its uri scheme is `untitled`). */
  readonly isUntitled: boolean
  getText(): string
}

/** One incremental edit within a {@link TextDocumentChangeEvent}. `range` is the
 *  replaced span in the document state after the previous change in the same
 *  event was applied (LSP semantics, 0-based); a change without `range` replaced
 *  the whole document (model flush, e.g. file reload). */
export interface TextDocumentContentChangeEvent {
  readonly range?: Range
  readonly text: string
}

/** Fired by `onDidChangeTextDocument`. `document` is the live (already updated)
 *  document; `contentChanges` carries the incremental edits that produced it. */
export interface TextDocumentChangeEvent {
  readonly document: TextDocument
  readonly contentChanges: readonly TextDocumentContentChangeEvent[]
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

/** How a text-editor selection change was triggered (mirrors VSCode's enum). */
export enum TextEditorSelectionChangeKind {
  Keyboard = 1,
  Mouse = 2,
  Command = 3,
}

/** Fired by {@link WindowApi.onDidChangeTextEditorSelection}. */
export interface TextEditorSelectionChangeEvent {
  /** Snapshot of the editor whose selection changed. */
  readonly textEditor: TextEditor
  readonly selections: readonly Selection[]
  /** Undefined when the change was programmatic (an explicit `setSelections`). */
  readonly kind: TextEditorSelectionChangeKind | undefined
}

/** Options for {@link WindowApi.showTextDocument}. */
export interface TextDocumentShowOptions {
  /** Show the editor without moving keyboard focus to it. */
  readonly preserveFocus?: boolean
  /** Open into the group's preview slot (unpinned; replaced by the next preview). */
  readonly preview?: boolean
  /** Select and reveal this range once the editor is up. */
  readonly selection?: Range
}

/** Where a decoration shows in the overview ruler (mirrors VSCode's enum). */
export enum OverviewRulerLane {
  Left = 1,
  Center = 2,
  Right = 4,
  Full = 7,
}

/**
 * A reference to a workbench color by id — a built-in color or one the extension
 * declared via `contributes.colors`. Pass it to a decoration's color fields
 * (`backgroundColor`/`borderColor`/`overviewRulerColor`) so the color follows the
 * active theme automatically instead of being pinned to a hex literal.
 */
export class ThemeColor {
  constructor(public readonly id: string) {}
}

/**
 * The visual styling of a decoration type. `gutterIconPath` is a data-URI (an
 * inline SVG, typically) painted in the editor's glyph margin; the color/border
 * fields style the line itself. Fixed at creation — to restyle, dispose and
 * recreate. Color fields accept a `ThemeColor` (theme-following) or a literal
 * hex/rgba string.
 */
export interface DecorationRenderOptions {
  /** Data-URI of an icon painted in the glyph margin (gutter). */
  gutterIconPath?: string
  /** Apply the line styling to the whole line, not just the decorated range. */
  isWholeLine?: boolean
  backgroundColor?: string | ThemeColor
  borderColor?: string | ThemeColor
  borderWidth?: string
  /**
   * Color painted in the overview ruler. A `ThemeColor` is resolved at decoration
   * creation; it does NOT live-refresh when the theme switches until the
   * decoration is re-set (VSCode semantic difference).
   */
  overviewRulerColor?: string | ThemeColor
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
   * The open workspace folder as a {@link WorkspaceFolder} list: empty-undefined
   * when no folder is open, otherwise exactly one entry with `index` 0.
   */
  readonly workspaceFolders: readonly WorkspaceFolder[] | undefined
  /** The workspace folder's basename, or undefined when no folder is open. */
  readonly name: string | undefined
  /**
   * Whether the current workspace is trusted (VSCode Workspace Trust). An
   * extension that runs workspace-provided code should gate that behind this.
   * Fixed at activation; a later grant fires {@link onDidGrantWorkspaceTrust}.
   */
  readonly isTrusted: boolean
  /**
   * Fires when the user grants trust to a previously-untrusted workspace. Trust
   * is never revoked in place (the host restarts instead), so there is no
   * corresponding revoke event.
   */
  readonly onDidGrantWorkspaceTrust: Event<void>
  /**
   * A path inside the workspace comes back root-relative (forward slashes, the
   * input's casing preserved); with `includeWorkspaceFolder` the folder's name
   * is prepended. A path outside the workspace is returned unchanged (a `Uri`
   * input yields its `fsPath`). Containment comparison follows the OS case
   * policy (case-insensitive on Windows) and either separator.
   */
  asRelativePath(pathOrUri: string | Uri, includeWorkspaceFolder?: boolean): string
  /**
   * Find files in the workspace matching the `include` glob (matched against
   * workspace-relative paths; a pattern without a slash matches the basename at
   * any depth). Pass a {@link RelativePattern} to root the enumeration at its
   * `base` folder — which must lie inside the workspace — and match `pattern`
   * against base-relative paths. `exclude`: one glob (a RelativePattern scopes
   * the exclusion to its own base), `null` to disable exclusion entirely, or
   * omit to use the configured search excludes (files.exclude ∪
   * search.exclude). Excludes prune during the enumeration itself: a glob
   * matching a directory skips its whole subtree, and excluded entries never
   * count against the enumeration cap. Cancelling `token` stops the underlying
   * enumeration; the promise then resolves with an empty list.
   */
  findFiles(
    include: GlobPattern,
    exclude?: GlobPattern | null,
    maxResults?: number,
    token?: CancellationToken,
  ): Promise<Uri[]>
  /**
   * Gated filesystem access. Every call is routed through the host's path policy
   * (denies sensitive locations, forbids escaping the workspace root) before
   * touching disk — the only filesystem an external/restricted extension gets.
   */
  readonly fs: FileSystemApi
  /** Documents currently open in the editor, mirrored from the renderer. */
  readonly textDocuments: readonly TextDocument[]
  /** Fires when a text document opens. Unlike VSCode, a freshly added listener
   *  is also called (asynchronously, exactly once per document) for every
   *  document already open at subscription time — an extension activated after
   *  the workbench restored its editors still sees them, no "poll
   *  {@link WorkspaceApi.textDocuments} after activate()" boilerplate needed. */
  readonly onDidOpenTextDocument: Event<TextDocument>
  readonly onDidChangeTextDocument: Event<TextDocumentChangeEvent>
  readonly onDidCloseTextDocument: Event<TextDocument>
  /**
   * Fires after a text document was written to disk. The mirrored document
   * already holds the saved text when this fires.
   */
  readonly onDidSaveTextDocument: Event<TextDocument>
  /**
   * Open a text document by URI or filesystem path. An already-open document is
   * reused (no disk re-read). Otherwise the file is loaded into the editor's
   * document model without showing it: the document joins the same live mirror
   * as any open editor, so it tracks later edits and fires
   * {@link WorkspaceApi.onDidOpenTextDocument} when it arrives. Rejects when the
   * target can't be read or isn't a `file:`/`untitled:` URI.
   *
   * An `untitled:` URI creates a never-on-disk document with that identity —
   * note (unlike VSCode) its path is only an identifier here; it does not seed
   * the later Save-As dialog.
   *
   * The options overload creates an untitled document (`isUntitled` is true,
   * uri scheme `untitled`) with the given language and initial content.
   */
  openTextDocument(target: Uri | string): Promise<TextDocument>
  openTextDocument(options?: { language?: string; content?: string }): Promise<TextDocument>
  /**
   * Apply a {@link WorkspaceEdit} across files. Text edits land on the live
   * editor models (undoable); files that aren't open are read, patched and
   * written back on disk. `documentChanges` may also carry file operations —
   * {@link CreateFile} / {@link RenameFile} / {@link DeleteFile} entries — which
   * run through the file system in array order together with the text edits
   * (honouring `overwrite` / `ignoreIfExists` / `ignoreIfNotExists` /
   * `recursive`). Resolves false when any entry fails; entries already applied
   * are not rolled back.
   */
  applyEdit(edit: WorkspaceEdit): Promise<boolean>
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
  /**
   * Fires when configuration values change. Changes made while the extension
   * host restarts are lost — re-read configuration after activation.
   */
  readonly onDidChangeConfiguration: Event<ConfigurationChangeEvent>
  /**
   * Watch workspace files for changes. `globPattern` is matched against
   * workspace-relative paths (a pattern without a slash matches the basename
   * at any depth). A {@link RelativePattern} scopes the watch to its `base`
   * folder (`pattern` matched against base-relative paths); a base outside
   * the workspace folder is watched too, via an out-of-workspace watch the
   * editor arms while the watcher is alive. An absolute glob string (e.g.
   * `D:\logs\**\*.log`) is split the same way: its literal root becomes the
   * base. Events flow only while at least one watcher is alive; dispose to
   * unsubscribe.
   */
  createFileSystemWatcher(
    globPattern: GlobPattern,
    ignoreCreateEvents?: boolean,
    ignoreChangeEvents?: boolean,
    ignoreDeleteEvents?: boolean,
  ): FileSystemWatcher
  /**
   * Register a timeline provider for the given URI scheme(s) (e.g. `['file']`).
   * The editor's built-in Timeline view queries it for the active file's history;
   * menu contributions under `timeline/item/context` gate on an item's
   * `contextValue` via the `timelineItem` context key.
   */
  registerTimelineProvider(
    scheme: string | readonly string[],
    provider: TimelineProvider,
  ): Disposable
}

/** The single workspace folder (single-folder model: the open folder). */
export interface WorkspaceFolder {
  readonly uri: Uri
  /** The folder's basename. */
  readonly name: string
  /** Always 0 in the single-folder model. */
  readonly index: number
}

/** Fired by `workspace.onDidChangeConfiguration`. */
export interface ConfigurationChangeEvent {
  /**
   * True when `section` changed: an affected key equals it, sits under it
   * (`'git'` matches a `git.autofetch` change), or prefixes it (`'git.autofetch'`
   * matches a `git` change).
   */
  affectsConfiguration(section: string): boolean
}

/**
 * A filesystem event source created by `workspace.createFileSystemWatcher`.
 * Events carry the affected file's URI; the `ignore*Events` flags reflect what
 * the watcher was created with.
 */
export interface FileSystemWatcher extends Disposable {
  readonly ignoreCreateEvents: boolean
  readonly ignoreChangeEvents: boolean
  readonly ignoreDeleteEvents: boolean
  readonly onDidCreate: Event<Uri>
  readonly onDidChange: Event<Uri>
  readonly onDidDelete: Event<Uri>
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

/** A minimal, gated filesystem — the subset of `vscode.workspace.fs` we support.
 *  Paths are absolute filesystem paths (strings), as with the rest of this API. */
export interface FileSystemApi {
  readFile(path: string): Promise<Uint8Array>
  writeFile(path: string, content: Uint8Array): Promise<void>
  stat(path: string): Promise<FileStat>
  readDirectory(path: string): Promise<[string, FileType][]>
  createDirectory(path: string): Promise<void>
  delete(path: string, options?: { recursive?: boolean }): Promise<void>
  /**
   * Rename/move `source` to `target`. Rejects when `target` exists and
   * `options.overwrite` is not set. Both paths pass the path policy.
   */
  rename(source: string, target: string, options?: { overwrite?: boolean }): Promise<void>
  /** Copy `source` to `target` (recursively for directories); same rules as {@link rename}. */
  copy(source: string, target: string, options?: { overwrite?: boolean }): Promise<void>
}

/** View over a configuration section (async — values live in the renderer). */
export interface WorkspaceConfiguration {
  get<T>(key: string, defaultValue: T): Promise<T>
  update(key: string, value: unknown): Promise<void>
}

/** Text-level access to the OS clipboard. */
export interface Clipboard {
  readText(): Promise<string>
  writeText(value: string): Promise<void>
}

/** The `env` namespace: information about the application the extension runs in. */
export interface EnvApi {
  /** The application (product) name. */
  readonly appName: string
  /** The application version string. */
  readonly appVersion: string
  /** The display language identifier, e.g. `'zh-CN'`. */
  readonly language: string
  /** Unique per editor session; stable across extension-host restarts within it. */
  readonly sessionId: string
  /** The URI scheme the OS routes to this application (its deep-link scheme). */
  readonly uriScheme: string
  /**
   * An anonymous id unique to this machine: a random UUID generated once and
   * persisted, stable across restarts and updates.
   */
  readonly machineId: string
  /** Absolute path of the application install root. */
  readonly appRoot: string
  /** The OS clipboard, text only. */
  readonly clipboard: Clipboard
  /**
   * Open a target: http(s) URLs go to the OS browser, file URIs/paths open in
   * the workbench. Resolves false when no opener handled the target.
   */
  openExternal(target: Uri | string): Promise<boolean>
}

/**
 * An installed extension as seen through the {@link extensions} namespace.
 * `isActive`/`exports` are live views: every read reflects the current
 * activation state, not a snapshot taken when the handle was obtained.
 */
export interface Extension<T = unknown> {
  /**
   * The extension id: `<publisher>.<name>` when the manifest declares a
   * publisher (e.g. `'universe.universe-pdf'`), otherwise the bare `name`
   * (e.g. `'@universe-editor/typescript'`).
   */
  readonly id: string
  /** Absolute path of the extension's install directory. */
  readonly extensionPath: string
  /** True once the extension's `activate` has completed successfully. */
  readonly isActive: boolean
  /** The parsed `package.json` manifest. */
  readonly packageJSON: Record<string, unknown>
  /** The value the extension's `activate` returned; undefined while inactive. */
  readonly exports: T | undefined
  /** Activate the extension (no-op when already active) and resolve its exports. */
  activate(): Promise<T | undefined>
}

/** The `extensions` namespace: inspect and activate the installed extensions. */
export interface ExtensionsApi {
  /** Every installed extension (built-in and external). */
  readonly all: readonly Extension[]
  /**
   * Look up an extension by id, e.g. `'universe.universe-pdf'`. The id is
   * `<publisher>.<name>` when the manifest declares a publisher, otherwise the
   * bare `name` (e.g. `'@universe-editor/typescript'`).
   */
  getExtension<T = unknown>(extensionId: string): Extension<T> | undefined
  /**
   * Fires when the installed extension set changes. Note: this product applies
   * extension install/enablement changes by restarting the extension host, so
   * within one host lifetime the set is fixed and this event never fires.
   */
  readonly onDidChange: Event<void>
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
  /**
   * `token` cancels a superseded query (the picker debounces keystrokes and
   * cancels the previous search) — pass it through to the underlying request
   * so a stale query doesn't keep the language server busy.
   */
  provideWorkspaceSymbols(
    query: string,
    token: CancellationToken,
  ): ProviderResult<WorkspaceSymbol[] | SymbolInformation[]>
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
 * Formats a range within a document (Format Selection). The given range is a
 * hint — the provider may expand it to whole syntax nodes.
 */
export interface DocumentRangeFormattingEditProvider {
  provideDocumentRangeFormattingEdits(
    document: TextDocument,
    range: Range,
    options: FormattingOptions,
  ): ProviderResult<TextEdit[]>
}

/**
 * Formats as the user types: the editor calls this after a trigger character
 * (registered via {@link LanguagesApi.registerOnTypeFormattingEditProvider}) is
 * typed. Only fires when the user has `editor.formatOnType` enabled (off by
 * default in this product).
 */
export interface OnTypeFormattingEditProvider {
  provideOnTypeFormattingEdits(
    document: TextDocument,
    position: Position,
    ch: string,
    options: FormattingOptions,
  ): ProviderResult<TextEdit[]>
}

/**
 * Provides inlay hints — inline annotations (e.g. parameter names, inferred
 * types) rendered inside the code. Two-phase like CodeLens: `provideInlayHints`
 * may return hints with a minimal label, and the editor calls
 * `resolveInlayHint` lazily for the hints actually shown, handing back the very
 * object the provider returned (its `data` payload included — `data` never
 * leaves the extension host). Fire `onDidChangeInlayHints` to make the editor
 * re-request hints (e.g. after a config change).
 */
export interface InlayHintsProvider {
  onDidChangeInlayHints?: Event<void>
  provideInlayHints(document: TextDocument, range: Range): ProviderResult<InlayHint[]>
  /**
   * Fill in the expensive parts of a hint (label parts' tooltips, `tooltip`,
   * `textEdits`) just before it is rendered. Receives the original object
   * returned by `provideInlayHints`; return it mutated or a new hint. Without
   * this method hints render exactly as provided.
   */
  resolveInlayHint?(hint: InlayHint): ProviderResult<InlayHint>
}

/**
 * Whole-document semantic tokens. `legend` names the numeric token-type /
 * modifier indices encoded in `SemanticTokens.data`; it's returned to Monaco
 * synchronously at registration, so the provider carries it as a field.
 */
export interface DocumentSemanticTokensProvider {
  readonly legend: SemanticTokensLegend
  provideDocumentSemanticTokens(document: TextDocument): ProviderResult<SemanticTokens>
  /**
   * Fire to make the editor re-request the whole document's tokens (e.g. after
   * a config change that swaps the highlight dialect). Mirrors
   * `onDidChangeCodeLenses`.
   */
  onDidChangeSemanticTokens?: Event<void>
}

/**
 * Range-limited semantic tokens. Same `legend` contract as
 * {@link DocumentSemanticTokensProvider}; the editor calls it lazily for the
 * visible range only.
 */
export interface DocumentRangeSemanticTokensProvider {
  readonly legend: SemanticTokensLegend
  provideDocumentRangeSemanticTokens(
    document: TextDocument,
    range: Range,
  ): ProviderResult<SemanticTokens>
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
 * The `ai` namespace: inference models and streaming requests. Available to all
 * extensions (single host — no trusted/restricted split); reachable once the
 * extension activates, subject to the same Workspace Trust gating as the rest
 * of the API.
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

/**
 * Lifecycle state of a language server backing a plugin's providers. Reported via
 * {@link LanguagesApi.setLanguageServerStatus} so the editor can tell the user the
 * server is coming up (a status-bar spinner) and let navigation commands await
 * readiness instead of blocking silently. `starting` covers spawn + handshake;
 * `ready` once usable; `error` on start failure.
 */
export type LanguageServerStatus = 'starting' | 'ready' | 'error'

/** Fired by {@link LanguagesApi.onDidChangeDiagnostics}. */
export interface DiagnosticChangeEvent {
  /**
   * The uris of the documents whose diagnostics changed — any owner, extension
   * collections and built-in language services alike.
   */
  readonly uris: readonly Uri[]
}

/** A pair of strings (`[open, close]`), e.g. a bracket or block-comment pair. */
export type CharacterPair = [string, string]

/** Comment rules for a {@link LanguageConfiguration}. */
export interface CommentRule {
  /** The line-comment token, e.g. `//`. */
  readonly lineComment?: string
  /** The block-comment delimiters (an opening and a closing token pair). */
  readonly blockComment?: CharacterPair
}

/**
 * Language configuration applied via {@link LanguagesApi.setLanguageConfiguration}.
 * Mirrors VSCode's type for the subset the editor supports: comments / brackets /
 * autoClosingPairs / surroundingPairs / wordPattern (indentation/onEnter/folding
 * rules are not applied).
 */
export interface LanguageConfiguration {
  readonly comments?: CommentRule
  readonly brackets?: readonly CharacterPair[]
  readonly autoClosingPairs?: readonly {
    readonly open: string
    readonly close: string
    readonly notIn?: readonly string[]
  }[]
  readonly surroundingPairs?: readonly { readonly open: string; readonly close: string }[]
  readonly wordPattern?: RegExp
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
  registerDocumentRangeFormattingEditProvider(
    selector: DocumentSelector,
    provider: DocumentRangeFormattingEditProvider,
  ): Disposable
  /**
   * Register a formatter that runs as the user types, after `firstTriggerCharacter`
   * (or any of `moreTriggerCharacter`) is entered. At least one trigger character
   * is required. Only effective when the user enables `editor.formatOnType`.
   */
  registerOnTypeFormattingEditProvider(
    selector: DocumentSelector,
    provider: OnTypeFormattingEditProvider,
    firstTriggerCharacter: string,
    ...moreTriggerCharacter: string[]
  ): Disposable
  registerInlayHintsProvider(selector: DocumentSelector, provider: InlayHintsProvider): Disposable
  registerDocumentSemanticTokensProvider(
    selector: DocumentSelector,
    provider: DocumentSemanticTokensProvider,
  ): Disposable
  registerDocumentRangeSemanticTokensProvider(
    selector: DocumentSelector,
    provider: DocumentRangeSemanticTokensProvider,
  ): Disposable
  registerCodeLensProvider(selector: DocumentSelector, provider: CodeLensProvider): Disposable
  createDiagnosticCollection(name?: string): DiagnosticCollection
  /**
   * Report the lifecycle state of a language server, keyed by `id` (e.g.
   * `'typescript'`). The editor surfaces `starting` as a status-bar spinner and
   * makes navigation commands (Go to Definition / References) show progress and
   * wait for `ready` rather than blocking silently during startup.
   */
  setLanguageServerStatus(id: string, status: LanguageServerStatus): void
  /** The ids of every language the editor currently knows (e.g. `'typescript'`). */
  getLanguages(): Promise<string[]>
  /**
   * Every diagnostic the editor currently shows — all owners, meaning every
   * extension's diagnostic collections plus the built-in language services
   * (VSCode's all-sources semantics, not just this extension's own collection).
   * With `resource`, only that document's diagnostics are returned.
   *
   * Unlike VSCode's synchronous version this returns a promise: the markers
   * live in the renderer process, so reading them crosses the extension-host
   * bridge (the same reason {@link getLanguages} is async).
   *
   * Read-back round-trips through the stringified marker form: `code` always
   * comes back in its string form (a numeric code published as `123` reads
   * back as `'123'` — VSCode has the same loss), `codeDescription.href` is
   * preserved, `relatedInformation` is dropped.
   */
  getDiagnostics(resource: Uri): Promise<[Uri, Diagnostic[]][]>
  getDiagnostics(): Promise<[Uri, Diagnostic[]][]>
  /**
   * Fires when any document's diagnostics change, from any owner. The renderer
   * batches a burst of marker updates into one event carrying all affected
   * uris, and pushes only while at least one listener is registered.
   */
  readonly onDidChangeDiagnostics: Event<DiagnosticChangeEvent>
  /**
   * Switch the language id of an already-open document. Equivalent to closing the
   * document in the old language and reopening it in `languageId`: `onDidCloseTextDocument`
   * / `onDidOpenTextDocument` fire and `onLanguage:<languageId>` extensions
   * activate. Resolves the replacement document; rejects when the document is not
   * open (or the switch fails).
   */
  setTextDocumentLanguage(document: TextDocument, languageId: string): Promise<TextDocument>
  /**
   * Apply a language configuration (comments / brackets / wordPattern / …) for
   * `language`. The returned Disposable revokes it. Later registrations for the
   * same language override earlier ones only until they are disposed (Monaco
   * semantics).
   */
  setLanguageConfiguration(language: string, configuration: LanguageConfiguration): Disposable
}
/**
 * Dialog options as they cross the in-process bridge: `defaultUri` is already
 * decomposed into `UriComponents` so the host never touches an extension's
 * bundled `Uri` class instance.
 */
interface OpenDialogOptionsBridge {
  defaultUri?: UriComponents
  openLabel?: string
  canSelectFiles?: boolean
  canSelectFolders?: boolean
  canSelectMany?: boolean
  filters?: Record<string, string[]>
  title?: string
}

/** See {@link OpenDialogOptionsBridge}. */
interface SaveDialogOptionsBridge {
  defaultUri?: UriComponents
  saveLabel?: string
  filters?: Record<string, string[]>
  title?: string
}

/**
 * The watcher handle crossing the in-process bridge: events carry raw
 * `UriComponents` so the host never hands an extension its own bundled `Uri`
 * instances — this module re-wraps them. KEEP IN SYNC with the producer in
 * `extension-host/src/apiFactory.ts`.
 */
interface FileSystemWatcherBridge extends Disposable {
  readonly ignoreCreateEvents: boolean
  readonly ignoreChangeEvents: boolean
  readonly ignoreDeleteEvents: boolean
  readonly onDidCreate: Event<UriComponents>
  readonly onDidChange: Event<UriComponents>
  readonly onDidDelete: Event<UriComponents>
}

/**
 * `languages.onDidChangeDiagnostics` payload over the bridge: raw
 * `UriComponents` re-wrapped into this module's `Uri` before reaching the
 * extension. KEEP IN SYNC with the producer in `extension-host/src/apiFactory.ts`.
 */
interface DiagnosticChangeEventBridge {
  readonly uris: readonly UriComponents[]
}

/**
 * The host bridge contract installed on globalThis. KEEP IN SYNC with the
 * producer in `extension-host/src/apiFactory.ts` (same key, same shapes).
 */
interface IExtensionHostBridge {
  registerCommand(command: string, handler: (...args: unknown[]) => unknown): Disposable
  executeCommand(command: string, args: unknown[]): Promise<unknown>
  getCommands(): Promise<string[]>
  getEnvironmentInfo(): {
    appName: string
    appVersion: string
    sessionId: string
    uriScheme: string
    language: string
    machineId: string
    appRoot: string
  }
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
  openTextDocument(
    target: UriComponents | string | { language?: string; content?: string } | undefined,
  ): Promise<TextDocument>
  readonly onDidChangeTextEditorSelection: Event<TextEditorSelectionChangeEvent>
  createSourceControl(id: string, label: string, rootUri?: string): SourceControl
  registerTimelineProvider(scheme: string[], provider: TimelineProvider): Disposable
  getActiveTextEditor(): Promise<TextEditor | undefined>
  readonly visibleTextEditors: readonly TextEditor[]
  readonly onDidChangeVisibleTextEditors: Event<readonly TextEditor[]>
  readonly windowState: WindowState
  readonly onDidChangeWindowState: Event<WindowState>
  getWorkspaceRoot(): string | undefined
  isWorkspaceTrusted(): boolean
  readonly onDidGrantWorkspaceTrust: Event<void>
  fsReadFile(path: string): Promise<Uint8Array>
  fsWriteFile(path: string, content: Uint8Array): Promise<void>
  fsStat(path: string): Promise<FileStat>
  fsReadDirectory(path: string): Promise<[string, FileType][]>
  fsCreateDirectory(path: string): Promise<void>
  fsDelete(path: string, recursive: boolean): Promise<void>
  fsRename(source: string, target: string, overwrite: boolean): Promise<void>
  fsCopy(source: string, target: string, overwrite: boolean): Promise<void>
  /**
   * `exclude` carries API semantics: undefined → the configured default search
   * excludes; null → no exclusion at all; a string → that glob. Returns fsPaths.
   */
  findFiles(
    include: GlobPattern,
    exclude: GlobPattern | null | undefined,
    maxResults: number | undefined,
    token?: CancellationToken,
  ): Promise<string[]>
  applyWorkspaceEdit(edit: WorkspaceEdit): Promise<boolean>
  createFileSystemWatcher(
    globPattern: GlobPattern,
    ignoreCreateEvents: boolean,
    ignoreChangeEvents: boolean,
    ignoreDeleteEvents: boolean,
  ): FileSystemWatcherBridge
  getConfiguration(
    section: string | undefined,
    key: string,
    defaultValue: unknown,
  ): Promise<unknown>
  updateConfiguration(section: string | undefined, key: string, value: unknown): Promise<void>
  createOutputChannel(name: string): OutputChannel
  readonly onDidChangeActiveTextEditor: Event<TextEditor | undefined>
  createTextEditorDecorationType(options: DecorationRenderOptions): TextEditorDecorationType
  registerCustomEditorProvider(
    viewType: string,
    provider: CustomReadonlyEditorProvider,
    options?: CustomEditorOptions,
  ): Disposable
  createWebviewPanel(
    viewType: string,
    title: string,
    showOptions?: { preserveFocus?: boolean },
    options?: WebviewOptions,
  ): WebviewPanel
  registerTreeDataProvider(viewId: string, provider: TreeDataProvider<unknown>): Disposable
  createTreeView(viewId: string, options: TreeViewOptions<unknown>): TreeView<unknown>
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
  registerDocumentRangeSemanticTokensProvider(
    selector: DocumentSelector,
    provider: DocumentRangeSemanticTokensProvider,
  ): Disposable
  registerCodeLensProvider(selector: DocumentSelector, provider: CodeLensProvider): Disposable
  createDiagnosticCollection(name?: string): DiagnosticCollection
  setLanguageServerStatus(id: string, status: LanguageServerStatus): void
  getLanguages(): Promise<string[]>
  setTextDocumentLanguage(document: TextDocument, languageId: string): Promise<TextDocument>
  setLanguageConfiguration(language: string, configuration: LanguageConfiguration): Disposable
  getDiagnostics(uri?: UriComponents): Promise<Array<[UriComponents, Diagnostic[]]>>
  readonly onDidChangeDiagnostics: Event<DiagnosticChangeEventBridge>
  getTextDocuments(): readonly TextDocument[]
  readonly onDidOpenTextDocument: Event<TextDocument>
  readonly onDidChangeTextDocument: Event<TextDocumentChangeEvent>
  readonly onDidCloseTextDocument: Event<TextDocument>
  readonly onWillSaveTextDocument: Event<WillSaveTextDocumentEvent>
  readonly onDidSaveTextDocument: Event<TextDocument>
  readonly onDidChangeConfiguration: Event<ConfigurationChangeEvent>
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
  getCommands: (filterInternal) =>
    bridge()
      .getCommands()
      .then((ids) => (filterInternal ? ids.filter((id) => !id.startsWith('_')) : ids)),
}

export const env: EnvApi = {
  get appName() {
    return bridge().getEnvironmentInfo().appName
  },
  get appVersion() {
    return bridge().getEnvironmentInfo().appVersion
  },
  get language() {
    return bridge().getEnvironmentInfo().language
  },
  get sessionId() {
    return bridge().getEnvironmentInfo().sessionId
  },
  get uriScheme() {
    return bridge().getEnvironmentInfo().uriScheme
  },
  get machineId() {
    return bridge().getEnvironmentInfo().machineId
  },
  get appRoot() {
    return bridge().getEnvironmentInfo().appRoot
  },
  clipboard: {
    readText: () => bridge().clipboardReadText(),
    writeText: (value) => bridge().clipboardWriteText(value),
  },
  openExternal: (target) =>
    bridge().openExternal(typeof target === 'string' ? target : target.toString()),
}

export const extensions: ExtensionsApi = {
  get all() {
    return bridge().getExtensions()
  },
  getExtension: <T = unknown>(extensionId: string): Extension<T> | undefined =>
    bridge().getExtension(extensionId) as Extension<T> | undefined,
  onDidChange: (listener) => bridge().onDidChangeExtensions(listener),
}

function toOpenDialogOptionsBridge(options: OpenDialogOptions): OpenDialogOptionsBridge {
  return {
    ...(options.defaultUri !== undefined ? { defaultUri: options.defaultUri.toJSON() } : {}),
    ...(options.openLabel !== undefined ? { openLabel: options.openLabel } : {}),
    ...(options.canSelectFiles !== undefined ? { canSelectFiles: options.canSelectFiles } : {}),
    ...(options.canSelectFolders !== undefined
      ? { canSelectFolders: options.canSelectFolders }
      : {}),
    ...(options.canSelectMany !== undefined ? { canSelectMany: options.canSelectMany } : {}),
    ...(options.filters !== undefined ? { filters: options.filters } : {}),
    ...(options.title !== undefined ? { title: options.title } : {}),
  }
}

function toSaveDialogOptionsBridge(options: SaveDialogOptions): SaveDialogOptionsBridge {
  return {
    ...(options.defaultUri !== undefined ? { defaultUri: options.defaultUri.toJSON() } : {}),
    ...(options.saveLabel !== undefined ? { saveLabel: options.saveLabel } : {}),
    ...(options.filters !== undefined ? { filters: options.filters } : {}),
    ...(options.title !== undefined ? { title: options.title } : {}),
  }
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
  setStatusBarMessage: (text: string, arg?: number | Promise<unknown>) =>
    bridge().setStatusBarMessage(text, arg),
  withProgress: <R>(
    options: ProgressOptions,
    task: (
      progress: Progress<{ message?: string; increment?: number }>,
      token: CancellationToken,
    ) => Promise<R>,
  ) => bridge().withProgress(options, task),
  showOpenDialog: (options) =>
    bridge()
      .showOpenDialog(options !== undefined ? toOpenDialogOptionsBridge(options) : undefined)
      .then((uris) => uris?.map((u) => Uri.from(u))),
  showSaveDialog: (options) =>
    bridge()
      .showSaveDialog(options !== undefined ? toSaveDialogOptionsBridge(options) : undefined)
      .then((uri) => (uri !== undefined ? Uri.from(uri) : undefined)),
  getActiveTextEditor: () => bridge().getActiveTextEditor(),
  onDidChangeActiveTextEditor: (listener) => bridge().onDidChangeActiveTextEditor(listener),
  get visibleTextEditors() {
    return bridge().visibleTextEditors
  },
  onDidChangeVisibleTextEditors: (listener) => bridge().onDidChangeVisibleTextEditors(listener),
  get state() {
    return bridge().windowState
  },
  onDidChangeWindowState: (listener) => bridge().onDidChangeWindowState(listener),
  showTextDocument: (target, options) =>
    bridge().showTextDocument(
      typeof target === 'string' ? target : 'uri' in target ? target.uri : target.toJSON(),
      options,
    ),
  onDidChangeTextEditorSelection: (listener) => bridge().onDidChangeTextEditorSelection(listener),
  createTextEditorDecorationType: (options) => bridge().createTextEditorDecorationType(options),
  registerCustomEditorProvider: (viewType, provider, options) =>
    bridge().registerCustomEditorProvider(viewType, provider, options),
  createWebviewPanel: (viewType, title, showOptions, options) =>
    bridge().createWebviewPanel(viewType, title, showOptions, options),
  registerTreeDataProvider: (viewId, provider) =>
    bridge().registerTreeDataProvider(viewId, provider),
  // Elements never cross the in-process bridge — only their host-allocated
  // handles do — so erasing T to unknown and back is sound.
  createTreeView: <T>(viewId: string, options: TreeViewOptions<T>): TreeView<T> =>
    bridge().createTreeView(viewId, options) as unknown as TreeView<T>,
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
  registerDocumentRangeFormattingEditProvider: (selector, provider) =>
    bridge().registerDocumentRangeFormattingEditProvider(selector, provider),
  registerOnTypeFormattingEditProvider: (selector, provider, firstTriggerCharacter, ...rest) =>
    bridge().registerOnTypeFormattingEditProvider(selector, provider, [
      firstTriggerCharacter,
      ...rest,
    ]),
  registerInlayHintsProvider: (selector, provider) =>
    bridge().registerInlayHintsProvider(selector, provider),
  registerDocumentSemanticTokensProvider: (selector, provider) =>
    bridge().registerDocumentSemanticTokensProvider(selector, provider),
  registerDocumentRangeSemanticTokensProvider: (selector, provider) =>
    bridge().registerDocumentRangeSemanticTokensProvider(selector, provider),
  registerCodeLensProvider: (selector, provider) =>
    bridge().registerCodeLensProvider(selector, provider),
  createDiagnosticCollection: (name) => bridge().createDiagnosticCollection(name),
  setLanguageServerStatus: (id, status) => bridge().setLanguageServerStatus(id, status),
  getLanguages: () => bridge().getLanguages(),
  setTextDocumentLanguage: (document, languageId) =>
    bridge().setTextDocumentLanguage(document, languageId),
  setLanguageConfiguration: (language, configuration) =>
    bridge().setLanguageConfiguration(language, configuration),
  getDiagnostics: (resource?: Uri) =>
    bridge()
      .getDiagnostics(resource?.toJSON())
      .then((entries) =>
        entries.map(([uri, diagnostics]) => [Uri.from(uri), diagnostics] as [Uri, Diagnostic[]]),
      ),
  onDidChangeDiagnostics: (listener) =>
    bridge().onDidChangeDiagnostics((e) => listener({ uris: e.uris.map((u) => Uri.from(u)) })),
}

export const workspace: WorkspaceApi = {
  get rootPath() {
    return bridge().getWorkspaceRoot()
  },
  get workspaceFolders() {
    const root = bridge().getWorkspaceRoot()
    if (root === undefined) return undefined
    return [{ uri: Uri.file(root), name: workspaceFolderName(root), index: 0 }]
  },
  get name() {
    const root = bridge().getWorkspaceRoot()
    return root === undefined ? undefined : workspaceFolderName(root)
  },
  get isTrusted() {
    return bridge().isWorkspaceTrusted()
  },
  onDidGrantWorkspaceTrust: (listener) => bridge().onDidGrantWorkspaceTrust(listener),
  asRelativePath: (pathOrUri, includeWorkspaceFolder) => {
    const input = typeof pathOrUri === 'string' ? pathOrUri : pathOrUri.fsPath
    const root = bridge().getWorkspaceRoot()
    if (root === undefined) return input
    return asRelativePathImpl(root, input, includeWorkspaceFolder === true)
  },
  findFiles: (include, exclude, maxResults, token) => {
    if (token?.isCancellationRequested) return Promise.resolve([])
    const pending = bridge().findFiles(include, exclude, maxResults, token)
    const wrap = (paths: string[]): Uri[] => paths.map((p) => Uri.file(p))
    // The token rides the RPC's cancel path and stops the enumeration itself
    // (see $findFiles in extensions-common); the client promise still settles
    // immediately with an empty list once cancellation fires.
    return new Promise<Uri[]>((resolve, reject) => {
      const sub = token?.onCancellationRequested(() => {
        sub?.dispose()
        resolve([])
      })
      pending.then(
        (paths) => {
          sub?.dispose()
          resolve(wrap(paths))
        },
        (err: unknown) => {
          sub?.dispose()
          if (token?.isCancellationRequested) resolve([])
          else reject(err instanceof Error ? err : new Error(String(err)))
        },
      )
    })
  },
  fs: {
    readFile: (path) => bridge().fsReadFile(path),
    writeFile: (path, content) => bridge().fsWriteFile(path, content),
    stat: (path) => bridge().fsStat(path),
    readDirectory: (path) => bridge().fsReadDirectory(path),
    createDirectory: (path) => bridge().fsCreateDirectory(path),
    delete: (path, options) => bridge().fsDelete(path, options?.recursive ?? false),
    rename: (source, target, options) =>
      bridge().fsRename(source, target, options?.overwrite ?? false),
    copy: (source, target, options) => bridge().fsCopy(source, target, options?.overwrite ?? false),
  },
  get textDocuments() {
    return bridge().getTextDocuments()
  },
  openTextDocument: (target) => {
    // The options overload (including a bare `openTextDocument()`) passes
    // through untouched — the bridge is in-process.
    if (target === undefined || (typeof target === 'object' && !('scheme' in target))) {
      return bridge().openTextDocument(target)
    }
    return bridge().openTextDocument(typeof target === 'string' ? target : target.toJSON())
  },
  applyEdit: (edit) => bridge().applyWorkspaceEdit(edit),
  onDidOpenTextDocument: (listener) => bridge().onDidOpenTextDocument(listener),
  onDidChangeTextDocument: (listener) => bridge().onDidChangeTextDocument(listener),
  onDidCloseTextDocument: (listener) => bridge().onDidCloseTextDocument(listener),
  onWillSaveTextDocument: (listener) => bridge().onWillSaveTextDocument(listener),
  onDidSaveTextDocument: (listener) => bridge().onDidSaveTextDocument(listener),
  onDidChangeConfiguration: (listener) => bridge().onDidChangeConfiguration(listener),
  getConfiguration: (section) => ({
    get: <T>(key: string, defaultValue: T): Promise<T> =>
      bridge().getConfiguration(section, key, defaultValue) as Promise<T>,
    update: (key: string, value: unknown): Promise<void> =>
      bridge().updateConfiguration(section, key, value),
  }),
  createFileSystemWatcher: (
    globPattern,
    ignoreCreateEvents,
    ignoreChangeEvents,
    ignoreDeleteEvents,
  ) => {
    const inner = bridge().createFileSystemWatcher(
      globPattern,
      ignoreCreateEvents ?? false,
      ignoreChangeEvents ?? false,
      ignoreDeleteEvents ?? false,
    )
    const wrap =
      (event: Event<UriComponents>): Event<Uri> =>
      (listener) =>
        event((u) => listener(Uri.from(u)))
    return {
      ignoreCreateEvents: inner.ignoreCreateEvents,
      ignoreChangeEvents: inner.ignoreChangeEvents,
      ignoreDeleteEvents: inner.ignoreDeleteEvents,
      onDidCreate: wrap(inner.onDidCreate),
      onDidChange: wrap(inner.onDidChange),
      onDidDelete: wrap(inner.onDidDelete),
      dispose: () => inner.dispose(),
    }
  },
  registerTimelineProvider: (scheme, provider) =>
    bridge().registerTimelineProvider(Array.isArray(scheme) ? [...scheme] : [scheme], provider),
}
