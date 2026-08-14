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
import { Emitter, isCancellationError, URI, type Event } from '@universe-editor/platform'
import {
  CancellationTokenSource,
  Disposable,
  FileType,
  Uri,
  type AiApi,
  type CancellationToken,
  type CodeActionProvider,
  type CodeLensProvider,
  type CompletionItemProvider,
  type ConfigurationChangeEvent,
  type CustomEditorOptions,
  type CustomReadonlyEditorProvider,
  type DecorationRenderOptions,
  type DefinitionProvider,
  type DiagnosticCollection,
  type DocumentFormattingEditProvider,
  type DocumentSelector,
  type DocumentSemanticTokensProvider,
  type DocumentHighlightProvider,
  type DocumentLinkProvider,
  type DocumentRangeFormattingEditProvider,
  type DocumentSymbolProvider,
  type Extension,
  type FileStat,
  type FoldingRangeProvider,
  type GlobPattern,
  type HoverProvider,
  type ImplementationProvider,
  type InlayHintsProvider,
  type InputBoxOptions,
  type LanguageServerStatus,
  type OnTypeFormattingEditProvider,
  type OutputChannel,
  type Progress,
  type ProgressOptions,
  type QuickPickItem,
  type QuickPickOptions,
  type ReferenceProvider,
  type RenameProvider,
  type SelectionRangeProvider,
  type SignatureHelpProvider,
  type SignatureHelpProviderMetadata,
  type SourceControl,
  StatusBarAlignment,
  type StatusBarItem,
  type TextDocument,
  type TextDocumentShowOptions,
  type TextEditor,
  type TextEditorDecorationType,
  type TextEditorSelectionChangeEvent,
  type TextEditorSelectionChangeKind,
  type TimelineProvider,
  type TreeDataProvider,
  type TreeView,
  type TreeViewOptions,
  type TypeDefinitionProvider,
  type UriComponents,
  type WebviewOptions,
  type WebviewPanel,
  type WorkspaceSymbolProvider,
} from '@universe-editor/extension-api'
import {
  base64ToBytes,
  bytesToBase64,
  type ExtHostFileType,
  type IActiveTextEditorDto,
  type ICodeActionContext,
  type ICompletionContext,
  type IFormattingOptionsDto,
  type IExtHostEnvironmentDto,
  type IExtHostFileStatDto,
  type IExtensionDescriptionDto,
  type IFileChangeEventDto,
  type IInlayHintDto,
  type IOpenDialogOptionsDto,
  type IProgressStepDto,
  type IReferenceContext,
  type IRelativePatternDto,
  type ISaveDialogOptionsDto,
  type ISelectionDto,
  type ISignatureHelpContext,
  type IMainThreadCommands,
  type IMainThreadFileEvents,
  type IMainThreadFs,
  type IMainThreadEditor,
  type IMainThreadLanguages,
  type IMainThreadOutput,
  type IMainThreadScm,
  type IMainThreadTimeline,
  type IMainThreadTreeViews,
  type ITextDocumentShowOptionsDto,
  type ITimelineDto,
  type ITimelineOptionsDto,
  type ITreeItemDto,
  type IMainThreadWindow,
  type IMainThreadAi,
  type IMainThreadStorage,
  type IMainThreadWebviews,
  type IMainThreadExtensions,
  type IWebviewDiffContextDto,
  type IWebviewPanelShowOptionsDto,
  type WillSaveReason,
  type TextDocumentContentChangeDto,
} from '@universe-editor/extensions-common'
import type {
  CodeAction,
  CodeLens,
  CompletionItem,
  CompletionList,
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
  SignatureHelp,
  SymbolInformation,
  TextEdit,
  WorkspaceEdit,
  WorkspaceSymbol,
} from 'vscode-languageserver-types'
import type { IScannedExtension } from './extensionScanner.js'
import { installApiBridge, type IExtensionHostBridge } from './apiFactory.js'
import type {
  DiagnosticChangeEventBridge,
  FileSystemWatcherBridge,
  OpenDialogOptionsBridge,
  SaveDialogOptionsBridge,
} from './apiFactory.js'
import { HostSourceControl } from './hostScm.js'
import { ExtHostTimelineRegistry } from './hostTimeline.js'
import { HostTreeViewRegistry } from './hostTreeViews.js'
import { HostWebviewManager } from './hostWebviews.js'
import { HostAi } from './hostAi.js'
import { ExtHostDocuments } from './hostDocuments.js'
import { HostFileWatcherRegistry } from './hostFileWatchers.js'
import { HostDiagnostics } from './hostDiagnostics.js'
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

/** Bridge options → wire DTO: `defaultUri` crosses as an fsPath string (a
 *  host-local path for the native dialog, not a remote workspace URI). */
function toOpenDialogDto(options?: OpenDialogOptionsBridge): IOpenDialogOptionsDto {
  return {
    ...(options?.defaultUri !== undefined
      ? { defaultUri: Uri.from(options.defaultUri).fsPath }
      : {}),
    ...(options?.openLabel !== undefined ? { openLabel: options.openLabel } : {}),
    ...(options?.canSelectFiles !== undefined ? { canSelectFiles: options.canSelectFiles } : {}),
    ...(options?.canSelectFolders !== undefined
      ? { canSelectFolders: options.canSelectFolders }
      : {}),
    ...(options?.canSelectMany !== undefined ? { canSelectMany: options.canSelectMany } : {}),
    ...(options?.filters !== undefined ? { filters: options.filters } : {}),
    ...(options?.title !== undefined ? { title: options.title } : {}),
  }
}

/** Bridge options → wire DTO: `defaultUri` crosses as an fsPath string (a
 *  host-local path for the native dialog, not a remote workspace URI). */
function toSaveDialogDto(options?: SaveDialogOptionsBridge): ISaveDialogOptionsDto {
  return {
    ...(options?.defaultUri !== undefined
      ? { defaultUri: Uri.from(options.defaultUri).fsPath }
      : {}),
    ...(options?.saveLabel !== undefined ? { saveLabel: options.saveLabel } : {}),
    ...(options?.filters !== undefined ? { filters: options.filters } : {}),
    ...(options?.title !== undefined ? { title: options.title } : {}),
  }
}

/** How long an active-editor change may wait for its document's didOpen to land
 *  (first activation pushes the full text after plugin activation — seconds for
 *  a huge file). Past this, the change is dropped rather than fired docless. */
const ACTIVE_EDITOR_DOC_WAIT_MS = 15_000

/** How long a visible-set push may hold its event for stragglers' didOpen
 *  before the layout change is reported with just the mirrored members. A cold
 *  document (first touch activates its language before the open push) mirrors
 *  within this window normally; a stuck pipeline must not stall it for 15s.
 *  Documents arriving later merge into the set and fire a follow-up event. */
const VISIBLE_EDITORS_DOC_GRACE_MS = 500

/** How long `openTextDocument` waits for the renderer's mirror push after its
 *  `$openTextDocument` RPC returned (language activation runs in between). */
const OPEN_TEXT_DOCUMENT_WAIT_MS = 15_000

/** Status-bar priority for `window.setStatusBarMessage`: higher sorts further
 *  from center, so a very negative value keeps transient messages closest. */
const STATUS_MESSAGE_PRIORITY = -1000

/**
 * Glob → wire shape: a plain string crosses verbatim; a `RelativePattern` is
 * decomposed so the host never hands the renderer an extension's bundled
 * `Uri` instance.
 */
function toWireGlobPattern(pattern: GlobPattern): string | IRelativePatternDto {
  return typeof pattern === 'string'
    ? pattern
    : { base: Uri.file(pattern.base).toJSON(), pattern: pattern.pattern }
}

export class ExtensionService implements IExtensionHostBridge {
  private readonly _commands: ExtensionCommandRegistry
  private readonly _languageRegistry: LanguageProviderRegistry
  private readonly _activation: ExtensionActivationService
  private readonly _documents = new ExtHostDocuments()
  private readonly _sourceControls = new Map<number, HostSourceControl>()
  private readonly _timelines: ExtHostTimelineRegistry
  private readonly _treeViews?: HostTreeViewRegistry
  private readonly _webviews?: HostWebviewManager
  private _statusBarHandle = 0
  private _scmHandle = 0
  private _outputHandle = 0
  private _decorationTypeHandle = 0
  private _progressHandle = 0
  /** Cancellation sources of in-flight `withProgress` tasks, keyed by handle. */
  private readonly _progressCancels = new Map<number, CancellationTokenSource>()
  /** Bumped per active-editor change; a held-back (doc-pending) change only
   *  fires if no newer change arrived while it waited. */
  private _activeEditorGeneration = 0

  private readonly _onDidChangeActiveTextEditor = new Emitter<TextEditor | undefined>()
  readonly onDidChangeActiveTextEditor: Event<TextEditor | undefined> =
    this._onDidChangeActiveTextEditor.event

  /** Latest visible set as TextEditor handles: every pushed snapshot whose
   *  document is mirrored (stragglers join later via `_onVisibleDocumentOpened`). */
  private _visibleTextEditors: readonly TextEditor[] = []
  /** The renderer's last whole-set push: authority over which editors belong. */
  private _visibleSnapshots: readonly IActiveTextEditorDto[] = []
  /** URI join of the last fired set — the event reports real set changes only. */
  private _lastFiredVisibleKey: string | null = null
  /** Holds back the event while a push waits for stragglers' mirrors. */
  private _visibleGraceTimer: ReturnType<typeof setTimeout> | undefined
  private readonly _onDidChangeVisibleTextEditors = new Emitter<readonly TextEditor[]>()
  readonly onDidChangeVisibleTextEditors: Event<readonly TextEditor[]> =
    this._onDidChangeVisibleTextEditors.event

  private readonly _onDidChangeTextEditorSelection = new Emitter<TextEditorSelectionChangeEvent>()
  readonly onDidChangeTextEditorSelection: Event<TextEditorSelectionChangeEvent> =
    this._onDidChangeTextEditorSelection.event

  /** Workspace Trust state; seeded via `$initializeWorkspaceTrust`, flipped by a grant. */
  private _trusted = false
  private readonly _onDidGrantWorkspaceTrust = new Emitter<void>()

  /** `env` namespace data; seeded via `$initializeEnvironment` before activation. */
  private _environment: IExtHostEnvironmentDto = {
    appName: '',
    appVersion: '',
    sessionId: '',
    uriScheme: '',
    language: '',
    machineId: '',
    appRoot: '',
  }

  /** Memoized `extensions` namespace handles, keyed by extension id. */
  private readonly _extensionApis = new Map<string, Extension<unknown>>()
  /** Never fires within a host lifetime: extension-set changes restart the host. */
  private readonly _onDidChangeExtensions = new Emitter<void>()
  readonly onDidChangeExtensions: Event<void> = this._onDidChangeExtensions.event

  readonly onDidOpenTextDocument = this._documents.onDidOpen
  readonly onDidChangeTextDocument = this._documents.onDidChange
  readonly onDidCloseTextDocument = this._documents.onDidClose
  readonly onWillSaveTextDocument = this._documents.onWillSave
  readonly onDidSaveTextDocument = this._documents.onDidSave

  private readonly _onDidChangeConfiguration = new Emitter<ConfigurationChangeEvent>()
  readonly onDidChangeConfiguration: Event<ConfigurationChangeEvent> =
    this._onDidChangeConfiguration.event

  /** Lazily created so a host without the file-events channel still works. */
  private _fileWatchers?: HostFileWatcherRegistry
  /** Lazily created so a host without the languages channel still works. */
  private _diagnostics?: HostDiagnostics

  constructor(
    private readonly _extensions: readonly IScannedExtension[],
    private readonly _mainThreadCommands: IMainThreadCommands,
    private readonly _mainThreadWindow: IMainThreadWindow,
    private readonly _mainThreadScm: IMainThreadScm,
    private readonly _mainThreadTimeline: IMainThreadTimeline,
    private readonly _workspaceRoot?: string,
    private readonly _mainThreadFs?: IMainThreadFs,
    private readonly _mainThreadOutput?: IMainThreadOutput,
    private readonly _mainThreadLanguages?: IMainThreadLanguages,
    private readonly _mainThreadEditor?: IMainThreadEditor,
    private readonly _mainThreadAi?: IMainThreadAi,
    private readonly _mainThreadStorage?: IMainThreadStorage,
    private readonly _mainThreadWebviews?: IMainThreadWebviews,
    private readonly _globalStorageHome?: string,
    private readonly _mainThreadExtensions?: IMainThreadExtensions,
    private readonly _mainThreadFileEvents?: IMainThreadFileEvents,
    private readonly _mainThreadTreeViews?: IMainThreadTreeViews,
  ) {
    this._commands = new ExtensionCommandRegistry(_mainThreadCommands)
    this._languageRegistry = new LanguageProviderRegistry(() => this._languages(), this._documents)
    this._timelines = new ExtHostTimelineRegistry(_mainThreadTimeline)
    this._activation = new ExtensionActivationService(
      _extensions,
      () => this._trusted,
      _mainThreadStorage,
      _globalStorageHome,
      _mainThreadExtensions
        ? (report) => _mainThreadExtensions.$onActivationError(report)
        : undefined,
    )
    if (_mainThreadWebviews) this._webviews = new HostWebviewManager(_mainThreadWebviews)
    if (_mainThreadTreeViews) {
      this._treeViews = new HostTreeViewRegistry(_mainThreadTreeViews, (command, args) =>
        this._commands.execute(command, args),
      )
    }
    this._documents.onDidOpen((document) => this._onVisibleDocumentOpened(document))
    installApiBridge(this)
  }

  // --- IExtensionHostBridge: commands ---

  registerCommand(command: string, handler: (...args: unknown[]) => unknown): Disposable {
    return this._commands.register(command, handler)
  }

  executeCommand(command: string, args: unknown[]): Promise<unknown> {
    return this._commands.execute(command, args)
  }

  getCommands(): Promise<string[]> {
    return this._commands.getCommands()
  }

  // --- IExtensionHostBridge: env ---

  /** IExtHostExtensions.$initializeEnvironment — pushed once by the renderer at connect. */
  initializeEnvironment(env: IExtHostEnvironmentDto): void {
    this._environment = env
  }

  getEnvironmentInfo(): IExtHostEnvironmentDto {
    return this._environment
  }

  clipboardReadText(): Promise<string> {
    return this._mainThreadWindow.$clipboardReadText()
  }

  clipboardWriteText(value: string): Promise<void> {
    return this._mainThreadWindow.$clipboardWriteText(value)
  }

  openExternal(target: string): Promise<boolean> {
    return this._mainThreadWindow.$openExternal(target)
  }

  // --- IExtensionHostBridge: extensions ---

  getExtensions(): readonly Extension<unknown>[] {
    return this._extensions.map((ext) => this._extensionApiFor(ext))
  }

  getExtension(extensionId: string): Extension<unknown> | undefined {
    const ext = this._extensions.find((e) => e.id === extensionId)
    return ext ? this._extensionApiFor(ext) : undefined
  }

  private _extensionApiFor(ext: IScannedExtension): Extension<unknown> {
    let api = this._extensionApis.get(ext.id)
    if (!api) {
      api = new HostExtension(ext, this._activation)
      this._extensionApis.set(ext.id, api)
    }
    return api
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

  /**
   * `window.setStatusBarMessage`: pure host-side sugar over the status-bar item
   * bridge (left, closest to center). Each call is an independent entry.
   */
  setStatusBarMessage(text: string, arg?: number | Promise<unknown>): Disposable {
    const item = this.createStatusBarItem(StatusBarAlignment.Left, STATUS_MESSAGE_PRIORITY)
    item.text = text
    item.show()
    let timer: ReturnType<typeof setTimeout> | undefined
    let disposed = false
    const dispose = (): void => {
      if (disposed) return
      disposed = true
      if (timer !== undefined) clearTimeout(timer)
      item.dispose()
    }
    if (typeof arg === 'number') {
      timer = setTimeout(dispose, arg)
    } else if (arg !== undefined) {
      void arg.then(dispose, dispose)
    }
    return new Disposable(dispose)
  }

  /**
   * `window.withProgress`: mount the renderer's progress UI for the duration of
   * `task`. Steps go out as they are reported; a user cancel rides back over
   * the `extHostWindow` channel and flips the task's token.
   */
  async withProgress<R>(
    options: ProgressOptions,
    task: (
      progress: Progress<{ message?: string; increment?: number }>,
      token: CancellationToken,
    ) => Promise<R>,
  ): Promise<R> {
    const handle = this._progressHandle++
    const cts = new CancellationTokenSource()
    this._progressCancels.set(handle, cts)
    try {
      await this._mainThreadWindow.$startProgress(handle, {
        location: options.location,
        ...(options.title !== undefined ? { title: options.title } : {}),
        ...(options.cancellable !== undefined ? { cancellable: options.cancellable } : {}),
      })
      const progress: Progress<{ message?: string; increment?: number }> = {
        report: (value) => {
          const step: IProgressStepDto = {
            ...(value.message !== undefined ? { message: value.message } : {}),
            ...(value.increment !== undefined ? { increment: value.increment } : {}),
          }
          void this._mainThreadWindow.$reportProgress(handle, step)
        },
      }
      return await task(progress, cts.token)
    } finally {
      this._progressCancels.delete(handle)
      cts.dispose()
      try {
        await this._mainThreadWindow.$endProgress(handle)
      } catch (err) {
        // A dead channel (host teardown) must not mask the task's own outcome.
        console.warn(`[ext-host] $endProgress(${handle}) failed: ${(err as Error).message}`)
      }
    }
  }

  /** IExtHostWindow.$acceptProgressCanceled — the user cancelled the progress UI. */
  acceptProgressCanceled(handle: number): void {
    this._progressCancels.get(handle)?.cancel()
  }

  async showOpenDialog(options?: OpenDialogOptionsBridge): Promise<UriComponents[] | undefined> {
    const picked = await this._mainThreadWindow.$showOpenDialog(toOpenDialogDto(options))
    return picked?.map((fsPath) => Uri.file(fsPath).toJSON())
  }

  async showSaveDialog(options?: SaveDialogOptionsBridge): Promise<UriComponents | undefined> {
    const picked = await this._mainThreadWindow.$showSaveDialog(toSaveDialogDto(options))
    return picked !== undefined ? Uri.file(picked).toJSON() : undefined
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
    diff?: IWebviewDiffContextDto,
  ): Promise<void> {
    if (!this._webviews) {
      throw new Error('custom editor support is not available in this extension host')
    }
    return this._webviews.resolveCustomEditor(providerHandle, panelHandle, viewType, uri, diff)
  }

  /** IExtHostWebviews.$onDidReceiveMessage */
  acceptWebviewMessage(panelHandle: number, message: unknown): void {
    this._webviews?.acceptMessage(panelHandle, message)
  }

  /** IExtensionHostBridge.createWebviewPanel */
  createWebviewPanel(
    viewType: string,
    title: string,
    showOptions?: IWebviewPanelShowOptionsDto,
    options?: WebviewOptions,
  ): WebviewPanel {
    if (!this._webviews) {
      throw new Error('webview panel support is not available in this extension host')
    }
    return this._webviews.createWebviewPanel(viewType, title, options, showOptions)
  }

  /** IExtHostWebviews.$acceptPanelDisposed */
  acceptPanelDisposed(panelHandle: number): void {
    this._webviews?.acceptPanelDisposed(panelHandle)
  }

  /** IExtHostWebviews.$acceptPanelViewState */
  acceptPanelViewState(panelHandle: number, active: boolean, visible: boolean): void {
    this._webviews?.acceptPanelViewState(panelHandle, active, visible)
  }

  /** IExtHostWebviews.$disposeWebviewPanel */
  disposeWebviewPanel(panelHandle: number): void {
    this._webviews?.disposePanel(panelHandle)
  }

  // --- IExtensionHostBridge: scm ---

  createSourceControl(id: string, label: string, rootUri?: string): SourceControl {
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

  // --- IExtensionHostBridge: timeline ---

  registerTimelineProvider(scheme: string[], provider: TimelineProvider): Disposable {
    return this._timelines.registerTimelineProvider(scheme, provider)
  }

  /** IExtHostTimeline.$provideTimeline */
  provideTimeline(
    handle: number,
    uri: string,
    options: ITimelineOptionsDto,
  ): Promise<ITimelineDto | undefined> {
    return this._timelines.provideTimeline(handle, uri, options)
  }

  // --- IExtensionHostBridge: tree views ---

  private _trees(): HostTreeViewRegistry {
    if (!this._treeViews) {
      throw new Error('tree view support is not available in this extension host')
    }
    return this._treeViews
  }

  registerTreeDataProvider(viewId: string, provider: TreeDataProvider<unknown>): Disposable {
    return this._trees().registerTreeDataProvider(viewId, provider)
  }

  createTreeView(viewId: string, options: TreeViewOptions<unknown>): TreeView<unknown> {
    return this._trees().createTreeView(viewId, options)
  }

  /** IExtHostTreeViews.$getChildren */
  provideTreeChildren(viewId: string, parentHandle?: number): Promise<ITreeItemDto[]> {
    return this._trees().getChildren(viewId, parentHandle)
  }

  /** IExtHostTreeViews.$acceptTreeViewVisibility */
  acceptTreeViewVisibility(viewId: string, visible: boolean): void {
    this._treeViews?.acceptVisibility(viewId, visible)
  }

  /** IExtHostTreeViews.$acceptSelection */
  acceptTreeViewSelection(viewId: string, handles: number[]): void {
    this._treeViews?.acceptSelection(viewId, handles)
  }

  /** IExtHostTreeViews.$acceptExpansionState */
  acceptTreeViewExpansionState(viewId: string, handle: number, expanded: boolean): void {
    this._treeViews?.acceptExpansionState(viewId, handle, expanded)
  }

  /** IExtHostTreeViews.$executeTreeItemCommand */
  executeTreeItemCommand(viewId: string, handle: number, commandId?: string): Promise<void> {
    return this._treeViews?.executeTreeItemCommand(viewId, handle, commandId) ?? Promise.resolve()
  }

  // --- IExtensionHostBridge: workspace ---

  getWorkspaceRoot(): string | undefined {
    return this._workspaceRoot
  }

  isWorkspaceTrusted(): boolean {
    return this._trusted
  }

  get onDidGrantWorkspaceTrust(): Event<void> {
    return this._onDidGrantWorkspaceTrust.event
  }

  /** Seed the initial trust state (renderer calls this once before activation). */
  initializeWorkspaceTrust(trusted: boolean): void {
    this._trusted = trusted
  }

  /** Trust granted at runtime: flip the flag, notify extensions, replay activation. */
  async grantWorkspaceTrust(): Promise<void> {
    if (this._trusted) return
    this._trusted = true
    this._onDidGrantWorkspaceTrust.fire()
    // Extensions gated off while untrusted now become activatable; replay every
    // activation event seen so far so `onLanguage:`-gated plugins start for
    // already-open documents.
    await this._activation.replayFiredEvents()
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

  fsRename(source: string, target: string, overwrite: boolean): Promise<void> {
    return this._fs().$rename(source, target, overwrite)
  }

  fsCopy(source: string, target: string, overwrite: boolean): Promise<void> {
    return this._fs().$copy(source, target, overwrite)
  }

  /**
   * `workspace.findFiles`: the renderer enumerates the workspace and glob-filters
   * there. API `exclude` semantics map onto the wire as: undefined → null (the
   * renderer's configured default excludes), null → [] (no exclusion), a glob →
   * a one-element list. The token travels via the channel's cancel path, so a
   * cancelled request stops the renderer-side enumeration and surfaces here as
   * a `CancellationError` rejection, normalized to the public contract's [].
   */
  async findFiles(
    include: GlobPattern,
    exclude: GlobPattern | null | undefined,
    maxResults: number | undefined,
    token?: CancellationToken,
  ): Promise<string[]> {
    const wireExclude =
      exclude === undefined ? null : exclude === null ? [] : [toWireGlobPattern(exclude)]
    try {
      return await this._fs().$findFiles(
        toWireGlobPattern(include),
        wireExclude,
        maxResults ?? null,
        token,
      )
    } catch (err) {
      if (token?.isCancellationRequested) {
        // A cancelled request is expected to surface as the channel's
        // CancellationError — kept silent. Any other rejection here is a real
        // failure that merely raced the cancel (path-policy reject, RPC drop):
        // log it before honouring the public contract's [] for cancellation.
        if (!isCancellationError(err)) {
          console.warn(
            `[extHost] findFiles failed alongside its cancellation: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
        return []
      }
      throw err
    }
  }

  /**
   * `workspace.applyEdit`. Supports text edits and create/rename/delete file
   * operations (`documentChanges` entries run in array order). The renderer
   * resolves false when any entry fails, which is the public contract as well.
   */
  applyWorkspaceEdit(edit: WorkspaceEdit): Promise<boolean> {
    return this._editor().$applyWorkspaceEdit(edit)
  }

  createFileSystemWatcher(
    globPattern: GlobPattern,
    ignoreCreateEvents: boolean,
    ignoreChangeEvents: boolean,
    ignoreDeleteEvents: boolean,
  ): FileSystemWatcherBridge {
    if (!this._fileWatchers) {
      if (!this._mainThreadFileEvents) {
        throw new Error('file system watchers are not available in this extension host')
      }
      this._fileWatchers = new HostFileWatcherRegistry(
        this._mainThreadFileEvents,
        this._workspaceRoot,
      )
    }
    return this._fileWatchers.createWatcher(
      globPattern,
      ignoreCreateEvents,
      ignoreChangeEvents,
      ignoreDeleteEvents,
    )
  }

  /** IExtHostFileEvents.$acceptFileEvents */
  acceptFileEvents(events: readonly IFileChangeEventDto[]): void {
    this._fileWatchers?.acceptFileEvents(events)
  }

  /** IExtHostExtensions.$acceptConfigurationChanged — renderer pushed a config change. */
  acceptConfigurationChanged(changedKeys: readonly string[]): void {
    if (changedKeys.length === 0) return
    const keys = [...changedKeys]
    this._onDidChangeConfiguration.fire({
      affectsConfiguration: (section) =>
        keys.some(
          (key) =>
            key === section || key.startsWith(`${section}.`) || section.startsWith(`${key}.`),
        ),
    })
  }

  getConfiguration(
    section: string | undefined,
    key: string,
    defaultValue: unknown,
  ): Promise<unknown> {
    const fullKey = section ? `${section}.${key}` : key
    return this.executeCommand('_workbench.getConfiguration', [fullKey, defaultValue])
  }

  async updateConfiguration(
    section: string | undefined,
    key: string,
    value: unknown,
  ): Promise<void> {
    const fullKey = section ? `${section}.${key}` : key
    await this.executeCommand('_workbench.updateConfiguration', [fullKey, value])
  }

  getTextDocuments(): readonly TextDocument[] {
    return this._documents.all()
  }

  /**
   * `workspace.openTextDocument`: reuse the mirror when the document is already
   * open; otherwise have the renderer load it into the sync pipeline and wait
   * for its `didOpen` to arrive. The options overload (or an `untitled:` URI)
   * creates a never-on-disk document instead of reading one.
   */
  async openTextDocument(
    target?: UriComponents | string | { language?: string; content?: string },
  ): Promise<TextDocument> {
    if (target === undefined || (typeof target === 'object' && !('scheme' in target))) {
      const components = await this._editor().$openUntitledDocument(target ?? {})
      const document = await this._documents.whenOpen(components, OPEN_TEXT_DOCUMENT_WAIT_MS)
      if (!document) {
        throw new Error('openTextDocument: document mirror never arrived for the untitled document')
      }
      return document
    }
    const uri = typeof target === 'string' ? Uri.file(target) : Uri.from(target)
    const components = uri.toJSON()
    const existing = this._documents.get(components)
    if (existing) return existing
    await this._editor().$openTextDocument(components)
    const document = await this._documents.whenOpen(components, OPEN_TEXT_DOCUMENT_WAIT_MS)
    if (!document) {
      throw new Error(`openTextDocument: document mirror never arrived for ${uri.toString()}`)
    }
    return document
  }

  /**
   * `window.showTextDocument`: the document enters the mirror first (so the
   * returned editor's document is live), then the renderer opens the editor.
   */
  async showTextDocument(
    target: UriComponents | string,
    options?: TextDocumentShowOptions,
  ): Promise<TextEditor> {
    const document = await this.openTextDocument(target)
    const showOptions: ITextDocumentShowOptionsDto = {
      ...(options?.preserveFocus !== undefined ? { preserveFocus: options.preserveFocus } : {}),
      ...(options?.preview !== undefined ? { preview: options.preview } : {}),
      ...(options?.selection !== undefined ? { selection: options.selection } : {}),
    }
    const snapshot = await this._editor().$showTextDocument(document.uri, showOptions)
    if (!snapshot) {
      throw new Error('showTextDocument: the editor did not open')
    }
    return this._editorFromSnapshot(snapshot, document)
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
    if (!snapshot) return undefined
    const document = await this._documents.whenOpen(snapshot.uri, ACTIVE_EDITOR_DOC_WAIT_MS)
    return document ? this._editorFromSnapshot(snapshot, document) : undefined
  }

  private _editorFromSnapshot(snapshot: IActiveTextEditorDto, document: TextDocument): TextEditor {
    const selections = snapshot.selections.map((s) => ({ anchor: s.anchor, active: s.active }))
    return new HostTextEditor(document, selections, snapshot.version, this._editor())
  }

  createTextEditorDecorationType(options: DecorationRenderOptions): TextEditorDecorationType {
    const handle = this._decorationTypeHandle++
    void this._editor().$createDecorationType(handle, toDecorationOptionsDto(options))
    return new HostTextEditorDecorationType(handle, this._editor())
  }

  /** IExtHostEditor.$acceptActiveEditorChange — renderer mirrors editor focus changes.
   *  The DTO carries no text; the document comes from the ExtHostDocuments mirror.
   *  When the mirror's didOpen is still in flight (first activation of a file),
   *  the event is held back until the document lands — unless a newer editor
   *  change supersedes it meanwhile. */
  acceptActiveEditorChange(snapshot: IActiveTextEditorDto | null): void {
    const generation = ++this._activeEditorGeneration
    if (!snapshot) {
      this._onDidChangeActiveTextEditor.fire(undefined)
      return
    }
    const document = this._documents.get(snapshot.uri)
    if (document) {
      this._onDidChangeActiveTextEditor.fire(this._editorFromSnapshot(snapshot, document))
      return
    }
    void this._documents.whenOpen(snapshot.uri, ACTIVE_EDITOR_DOC_WAIT_MS).then((lateDoc) => {
      if (generation !== this._activeEditorGeneration || !lateDoc) return
      this._onDidChangeActiveTextEditor.fire(this._editorFromSnapshot(snapshot, lateDoc))
    })
  }

  /** `window.visibleTextEditors`: the latest pushed set restricted to documents
   *  already mirrored. A cold document's mirror lands a moment after the push
   *  (its language activates before the open push): inside that window the
   *  getter serves the known subset and converges to the full set on didOpen. */
  get visibleTextEditors(): readonly TextEditor[] {
    return this._visibleTextEditors
  }

  /** IExtHostEditor.$acceptVisibleEditorsChange — the renderer's whole-set
   *  mirror of the per-group visible text editors. The getter swaps immediately
   *  (never a stale set); the event waits out a short grace for not-yet-mirrored
   *  documents (same first-activation race as the active editor) so a layout
   *  change reports the complete set in the common case, then reports the
   *  best-known subset rather than sitting behind a stuck mirror for 15s.
   *  A document mirroring later merges in by editor and fires a follow-up. */
  acceptVisibleEditorsChange(snapshots: readonly IActiveTextEditorDto[]): void {
    this._visibleSnapshots = snapshots
    this._rebuildVisibleTextEditors()
    if (this._visibleTextEditors.length === snapshots.length) {
      this._cancelVisibleEditorsGrace()
    } else {
      if (this._visibleGraceTimer !== undefined) clearTimeout(this._visibleGraceTimer)
      this._visibleGraceTimer = setTimeout(() => {
        this._visibleGraceTimer = undefined
        this._reportVisibleTextEditors()
      }, VISIBLE_EDITORS_DOC_GRACE_MS)
    }
    this._reportVisibleTextEditors()
  }

  /** Re-sync the getter with the latest pushed set, in group order. */
  private _rebuildVisibleTextEditors(): void {
    const editors: TextEditor[] = []
    for (const snapshot of this._visibleSnapshots) {
      const document = this._documents.get(snapshot.uri)
      if (document) editors.push(this._editorFromSnapshot(snapshot, document))
    }
    this._visibleTextEditors = editors
  }

  /** A document just mirrored: when it belongs to the latest pushed set, a held
   *  member resolved — merge it in and report. Outside the set (the editor moved
   *  on meanwhile) it is ignored. No wait-time window caps this: a mirror that
   *  lands ages late still completes the set instead of being dropped by a
   *  stale generation guard. */
  private _onVisibleDocumentOpened(document: TextDocument): void {
    const member = this._visibleSnapshots.some(
      (snapshot) => this._documents.get(snapshot.uri) === document,
    )
    if (!member) return
    this._rebuildVisibleTextEditors()
    if (this._visibleTextEditors.length === this._visibleSnapshots.length) {
      this._cancelVisibleEditorsGrace()
    }
    this._reportVisibleTextEditors()
  }

  /** Report the getter's set to extensions — silent while a grace timer still
   *  waits for stragglers, and only when the set actually changed. */
  private _reportVisibleTextEditors(): void {
    if (this._visibleGraceTimer !== undefined) return
    const key = this._visibleTextEditors
      .map((editor) => URI.revive(editor.document.uri)?.toString() ?? '')
      .join('|')
    if (key === this._lastFiredVisibleKey) return
    this._lastFiredVisibleKey = key
    this._onDidChangeVisibleTextEditors.fire(this._visibleTextEditors)
  }

  private _cancelVisibleEditorsGrace(): void {
    if (this._visibleGraceTimer === undefined) return
    clearTimeout(this._visibleGraceTimer)
    this._visibleGraceTimer = undefined
  }

  /**
   * IExtHostEditor.$acceptSelectionChange — renderer mirrors selection changes of
   * the active editor (debounced there). The document comes from the mirror; a
   * change for an unmirrored document is dropped.
   */
  acceptSelectionChange(
    uri: UriComponents,
    selections: readonly ISelectionDto[],
    kind: number | undefined,
  ): void {
    if (!this._mainThreadEditor) return
    const document = this._documents.get(uri)
    if (!document) return
    const sels = selections.map((s) => ({ anchor: s.anchor, active: s.active }))
    const editor = new HostTextEditor(document, sels, document.version, this._mainThreadEditor)
    this._onDidChangeTextEditorSelection.fire({
      textEditor: editor,
      selections: sels,
      // Tolerate an explicitly-cast null: the public event uses undefined.
      kind: (kind ?? undefined) as TextEditorSelectionChangeKind | undefined,
    })
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

  registerDocumentFormattingEditProvider(
    selector: DocumentSelector,
    provider: DocumentFormattingEditProvider,
  ): Disposable {
    return this._languageRegistry.registerDocumentFormattingEditProvider(selector, provider)
  }

  registerDocumentRangeFormattingEditProvider(
    selector: DocumentSelector,
    provider: DocumentRangeFormattingEditProvider,
  ): Disposable {
    return this._languageRegistry.registerDocumentRangeFormattingEditProvider(selector, provider)
  }

  registerOnTypeFormattingEditProvider(
    selector: DocumentSelector,
    provider: OnTypeFormattingEditProvider,
    triggerCharacters: readonly string[],
  ): Disposable {
    return this._languageRegistry.registerOnTypeFormattingEditProvider(
      selector,
      provider,
      triggerCharacters,
    )
  }

  registerInlayHintsProvider(selector: DocumentSelector, provider: InlayHintsProvider): Disposable {
    return this._languageRegistry.registerInlayHintsProvider(selector, provider)
  }

  registerDocumentSemanticTokensProvider(
    selector: DocumentSelector,
    provider: DocumentSemanticTokensProvider,
  ): Disposable {
    return this._languageRegistry.registerDocumentSemanticTokensProvider(selector, provider)
  }

  registerCodeLensProvider(selector: DocumentSelector, provider: CodeLensProvider): Disposable {
    return this._languageRegistry.registerCodeLensProvider(selector, provider)
  }

  createDiagnosticCollection(name?: string): DiagnosticCollection {
    return this._languageRegistry.createDiagnosticCollection(name)
  }

  setLanguageServerStatus(id: string, status: LanguageServerStatus): void {
    this._languages().$setLanguageServerStatus(id, status)
  }

  getLanguages(): Promise<string[]> {
    return this._languages().$getLanguages()
  }

  getDiagnostics(uri?: UriComponents): Promise<Array<[UriComponents, Diagnostic[]]>> {
    return this._hostDiagnostics().getDiagnostics(uri)
  }

  get onDidChangeDiagnostics(): Event<DiagnosticChangeEventBridge> {
    return this._hostDiagnostics().onDidChangeDiagnostics
  }

  private _hostDiagnostics(): HostDiagnostics {
    return (this._diagnostics ??= new HostDiagnostics(this._languages()))
  }

  /** IExtHostLanguages.$acceptDiagnosticsChange — renderer push (fire-and-forget). */
  acceptDiagnosticsChange(uris: readonly UriComponents[]): void {
    this._diagnostics?.acceptDiagnosticsChange(uris)
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
  acceptDocumentChange(
    uri: UriComponents,
    version: number,
    changes: readonly TextDocumentContentChangeDto[],
  ): void {
    this._documents.acceptChange(uri, version, changes)
  }

  /** IExtHostDocuments.$acceptDocumentClose */
  acceptDocumentClose(uri: UriComponents): void {
    this._documents.acceptClose(uri)
  }

  /** IExtHostDocuments.$provideWillSaveEdits */
  provideWillSaveEdits(uri: UriComponents, reason: WillSaveReason): Promise<TextEdit[]> {
    return this._documents.provideWillSaveEdits(uri, reason)
  }

  /** IExtHostDocuments.$acceptDocumentSave */
  acceptDocumentSave(uri: UriComponents): void {
    this._documents.acceptSave(uri)
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

  cancelWorkspaceSymbols(handle: number): void {
    this._languageRegistry.cancelWorkspaceSymbols(handle)
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

  provideDocumentFormattingEdits(
    handle: number,
    uri: UriComponents,
    options: IFormattingOptionsDto,
  ): Promise<TextEdit[] | null> {
    return this._languageRegistry.provideDocumentFormattingEdits(handle, uri, options)
  }

  provideDocumentRangeFormattingEdits(
    handle: number,
    uri: UriComponents,
    range: Range,
    options: IFormattingOptionsDto,
  ): Promise<TextEdit[] | null> {
    return this._languageRegistry.provideDocumentRangeFormattingEdits(handle, uri, range, options)
  }

  provideOnTypeFormattingEdits(
    handle: number,
    uri: UriComponents,
    position: Position,
    ch: string,
    options: IFormattingOptionsDto,
  ): Promise<TextEdit[] | null> {
    return this._languageRegistry.provideOnTypeFormattingEdits(handle, uri, position, ch, options)
  }

  provideInlayHints(
    handle: number,
    uri: UriComponents,
    range: Range,
  ): Promise<IInlayHintDto[] | null> {
    return this._languageRegistry.provideInlayHints(handle, uri, range)
  }

  resolveInlayHint(handle: number, cacheId: number, index: number): Promise<IInlayHintDto | null> {
    return this._languageRegistry.resolveInlayHint(handle, cacheId, index)
  }

  provideDocumentSemanticTokens(
    handle: number,
    uri: UriComponents,
  ): Promise<SemanticTokens | null> {
    return this._languageRegistry.provideDocumentSemanticTokens(handle, uri)
  }

  provideCodeLenses(handle: number, uri: UriComponents): Promise<CodeLens[] | null> {
    return this._languageRegistry.provideCodeLenses(handle, uri)
  }

  resolveCodeLens(handle: number, lens: CodeLens): Promise<CodeLens | null> {
    return this._languageRegistry.resolveCodeLens(handle, lens)
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
        hasMain: ext.manifest.main !== undefined,
        extensionLocation: URI.file(ext.extensionPath).toJSON(),
        extensionIsBuiltin: ext.builtin,
        ...(ext.isUnderDevelopment === true ? { extensionIsUnderDevelopment: true } : {}),
        ...(ext.manifest.capabilities?.untrustedWorkspaces !== undefined
          ? { untrustedWorkspaces: ext.manifest.capabilities.untrustedWorkspaces }
          : {}),
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
    this._timelines.dispose()
    this._treeViews?.dispose()
    this._fileWatchers?.dispose()
    this._diagnostics?.dispose()
    this._activation.disposeAll()
  }
}

/**
 * The handle behind `extensions.getExtension()`. `isActive`/`exports` are live
 * getters over the activation service, so a handle obtained before activation
 * reflects the state change afterwards (no snapshot).
 */
class HostExtension implements Extension<unknown> {
  constructor(
    private readonly _scanned: IScannedExtension,
    private readonly _activation: ExtensionActivationService,
  ) {}

  get id(): string {
    return this._scanned.id
  }

  get extensionPath(): string {
    return this._scanned.extensionPath
  }

  get isActive(): boolean {
    return this._activation.isActivated(this._scanned.id)
  }

  get packageJSON(): Record<string, unknown> {
    return this._scanned.manifest as unknown as Record<string, unknown>
  }

  get exports(): unknown {
    return this._activation.getExports(this._scanned.id)
  }

  activate(): Promise<unknown> {
    return this._activation.activateById(this._scanned.id)
  }
}
